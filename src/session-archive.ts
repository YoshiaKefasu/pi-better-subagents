/**
 * Session archive: sweep stale subagent session transcripts into an
 * `archive/` subdirectory of the session dir.
 *
 * Subagent sessions persist a pi session file per run (see
 * `src/agent-runner.ts:persistSession`), so a busy project accumulates
 * hundreds of JSONL transcripts. Only sessions whose header carries a
 * `parentSession` (i.e. transcripts of subagents) and that have been idle
 * longer than the age window are ever moved; the main session's file has no
 * parent and is never touched. `archive/` itself is outside the scan, so
 * archived files stay archived.
 */

import { Buffer } from "node:buffer";
import {
  closeSync,
  type Dirent,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  type Stats,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Name of the subdirectory stale sessions move into. */
export const ARCHIVE_DIR_NAME = "archive";
/** Default idle age (hours) after which a subagent session is archivable. */
export const DEFAULT_ARCHIVE_AGE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/** How much of a session file we read — the header is one short first line. */
const HEADER_READ_LIMIT = 8192;

/** A session file that is old enough and belongs to a subagent. */
export interface ArchivableSession {
  /** Absolute path of the session file (still in the live session dir). */
  path: string;
  /** `parentSession` from the session header; proof it is a subagent transcript. */
  parentSession: string;
  /** File modification time (ms since epoch), the age this scan judged by. */
  modifiedMs: number;
}

/** Result of {@link archiveSessions}. */
export interface ArchiveResult {
  /** Source paths moved into `<sessionDir>/archive/` (or that would move, with dryRun). */
  archived: string[];
  /** Source paths left in place: a name collision in archive/ or a failed move. */
  skipped: string[];
}

export interface ArchiveOptions {
  /** Report the moves without touching the filesystem. */
  dryRun?: boolean;
}

/** Configured `session-archive` section from pi's settings.json files. */
export interface SessionArchiveConfig {
  enabled: boolean;
  maxAgeHours: number;
}

/**
 * Paths to pi's settings.json files: [project, global] — project takes
 * precedence, mirroring `src/enabled-models.ts` (which reads `enabledModels`
 * from the same two files).
 */
function settingsPaths(cwd: string): [project: string, global: string] {
  return [
    join(cwd, ".pi", "settings.json"),
    join(getAgentDir(), "settings.json"),
  ];
}

/** Read the `session-archive` section of one settings file. Undefined when absent/unreadable. */
function readArchiveSection(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const section = typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)["session-archive"]
      : undefined;
    return typeof section === "object" && section !== null && !Array.isArray(section)
      ? (section as Record<string, unknown>)
      : undefined;
  } catch {
    // Corrupt settings file — treat the section as absent, never as an error.
    return undefined;
  }
}

/**
 * Read the `session-archive` section from pi settings — project overrides
 * global per field, matching pi's own SettingsManager precedence.
 * Returns undefined when neither file carries the section (the caller then
 * does nothing); `enabled` defaults to false and `maxAgeHours` to
 * {@link DEFAULT_ARCHIVE_AGE_HOURS}.
 */
export function readArchiveConfig(cwd: string): SessionArchiveConfig | undefined {
  const [project, global] = settingsPaths(cwd);
  const globalSection = readArchiveSection(global);
  const projectSection = readArchiveSection(project);
  if (!globalSection && !projectSection) return undefined;
  const section = { ...(globalSection ?? {}), ...(projectSection ?? {}) };
  const maxAgeHours = typeof section.maxAgeHours === "number" && section.maxAgeHours > 0
    ? section.maxAgeHours
    : DEFAULT_ARCHIVE_AGE_HOURS;
  return { enabled: section.enabled === true, maxAgeHours };
}

/**
 * Read only the first line of a session JSONL and pull `parentSession` off
 * the header. Bounded read: transcripts can be tens of MB, and the header is
 * always the first line. Returns undefined when the file is unreadable,
 * empty, or its first line is not a parseable session header.
 */
function readHeaderParentSession(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = new Uint8Array(HEADER_READ_LIMIT);
    const n = readSync(fd, bytes);
    if (n <= 0) return undefined;
    const newline = bytes.indexOf(0x0a);
    const headerBytes = newline >= 0 ? bytes.subarray(0, newline) : bytes.subarray(0, n);
    const header = JSON.parse(Buffer.from(headerBytes).toString("utf8"));
    if (typeof header !== "object" || header === null) return undefined;
    const parent = (header as { parentSession?: unknown }).parentSession;
    return typeof parent === "string" && parent.length > 0 ? parent : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Find session files that are both subagent transcripts (header
 * `parentSession`) and strictly older than `maxAgeMs` (idle time, judged by
 * file mtime). Directories — the `archive/` dir included — and anything that
 * is not a `.jsonl` file are out of the scan. Unreadable files and files
 * whose first line does not parse as a session header are skipped.
 */
export function scanArchivableSessions(sessionDir: string, maxAgeMs: number): ArchivableSession[] {
  if (maxAgeMs <= 0) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    // Missing or unreadable session dir — nothing to scan.
    return [];
  }
  const cutoff = Date.now() - maxAgeMs;
  const found: ArchivableSession[] = [];
  for (const entry of entries) {
    // archive/ (and any other subdirectory) is never descended into; backup
    // suffixes and stray files are not session transcripts.
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(sessionDir, entry.name);
    let stat: Stats;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    // Strictly older: age = now - mtime must EXCEED maxAgeMs.
    if (stat.mtimeMs >= cutoff) continue;
    const parentSession = readHeaderParentSession(path);
    // Main sessions have no parent in their header — they must never move.
    if (parentSession === undefined) continue;
    found.push({ path, parentSession, modifiedMs: stat.mtimeMs });
  }
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}

/**
 * Move stale subagent sessions into `<sessionDir>/archive/`, creating the
 * archive dir on demand. A name that already exists in archive/ is never
 * overwritten — the source lands in `skipped` and stays in place, as does a
 * file whose move fails. With `dryRun`, nothing is created or moved; the
 * result reports the moves that would happen.
 */
export function archiveSessions(
  sessionDir: string,
  maxAgeMs: number,
  options: ArchiveOptions = {},
): ArchiveResult {
  const result: ArchiveResult = { archived: [], skipped: [] };
  const candidates = scanArchivableSessions(sessionDir, maxAgeMs);
  if (candidates.length === 0) return result;
  const archiveDir = join(sessionDir, ARCHIVE_DIR_NAME);
  if (!options.dryRun) {
    // Survival is judged per file below; a failed mkdir only means every
    // rename fails, and the sources stay where they are.
    try { mkdirSync(archiveDir, { recursive: true }); } catch { /* fall through */ }
  }
  for (const { path } of candidates) {
    const dest = join(archiveDir, basename(path));
    if (existsSync(dest)) {
      result.skipped.push(path);
      continue;
    }
    if (options.dryRun) {
      result.archived.push(path);
      continue;
    }
    try {
      renameSync(path, dest);
      result.archived.push(path);
    } catch {
      result.skipped.push(path);
    }
  }
  return result;
}

/** Convert a `session-archive.maxAgeHours` value to the ms scan/archive expect. */
export function archiveAgeMs(maxAgeHours: number): number {
  return maxAgeHours * HOUR_MS;
}