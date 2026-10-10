// Session archive: stale subagent transcripts move to <sessionDir>/archive/.
//
// Main (parent-less) sessions must never move; fresh sessions, unparseable
// files, backup-named files, and the archive/ dir itself are all out of the
// scan. archiveSessions() is the only writer: it renames, never copies or
// overwrites, so a name collision in archive/ leaves the source in place.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARCHIVE_DIR_NAME,
  archiveAgeMs,
  archiveSessions,
  DEFAULT_ARCHIVE_AGE_HOURS,
  readArchiveConfig,
  scanArchivableSessions,
} from "../src/session-archive.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Write a session file whose header is `header` (spread over the real fields). */
function writeSession(
  dir: string,
  name: string,
  header: Record<string, unknown>,
  ageMs: number = 0,
): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "01a00000-0000-0000-0000-000000000000",
      timestamp: new Date().toISOString(),
      cwd: "C:\\proj",
      ...header,
    }),
    "utf8",
  );
  if (ageMs > 0) {
    const mtime = new Date(Date.now() - ageMs);
    utimesSync(path, mtime, mtime);
  }
  return path;
}

describe("constants", () => {
  it("exposes the archive dir name and default age in hours", () => {
    expect(ARCHIVE_DIR_NAME).toBe("archive");
    expect(DEFAULT_ARCHIVE_AGE_HOURS).toBe(24);
    expect(archiveAgeMs(DEFAULT_ARCHIVE_AGE_HOURS)).toBe(24 * HOUR_MS);
  });
});

describe("scanArchivableSessions", () => {
  let dir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-session-archive-"));
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("finds only stale subagent sessions — never main, fresh, or non-jsonl files", () => {
    const mainPath = writeSession(dir, "main.jsonl", {}, 2 * DAY_MS);
    const staleSub = writeSession(dir, "sub-a.jsonl", { parentSession: "C:\\proj\\parent.jsonl" }, 2 * DAY_MS);
    writeSession(dir, "sub-b.jsonl", { parentSession: "C:\\proj\\parent.jsonl" }, 1 * HOUR_MS);
    writeSession(dir, "notes.txt", { parentSession: "C:\\proj\\parent.jsonl" }, 2 * DAY_MS);

    const found = scanArchivableSessions(dir, DAY_MS);

    expect(found.map(s => s.path)).toEqual([staleSub]);
    expect(found[0].parentSession).toBe("C:\\proj\\parent.jsonl");
    expect(found[0].path).not.toBe(mainPath);
  });

  it("skips files whose first line is not a parseable subagent header", () => {
    const broken = join(dir, "broken.jsonl");
    writeFileSync(broken, "this is not json at all\n{\"type\":\"message\"}", "utf8");
    utimesSync(broken, new Date(Date.now() - 2 * DAY_MS), new Date(Date.now() - 2 * DAY_MS));
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "", "utf8");
    utimesSync(empty, new Date(Date.now() - 2 * DAY_MS), new Date(Date.now() - 2 * DAY_MS));
    // Valid JSON but no parentSession — same as a main session, must stay.
    const noParent = join(dir, "no-parent.jsonl");
    writeFileSync(noParent, "{\"type\":\"message\",\"id\":\"m1\"}\n", "utf8");
    utimesSync(noParent, new Date(Date.now() - 2 * DAY_MS), new Date(Date.now() - 2 * DAY_MS));
    const good = writeSession(dir, "sub-ok.jsonl", { parentSession: "p" }, 2 * DAY_MS);

    const found = scanArchivableSessions(dir, DAY_MS);

    expect(found.map(s => s.path)).toEqual([good]);
  });

  it("never descends into archive/ (or any subdirectory)", () => {
    mkdirSync(join(dir, ARCHIVE_DIR_NAME));
    writeSession(join(dir, ARCHIVE_DIR_NAME), "already-old.jsonl", { parentSession: "p" }, 2 * DAY_MS);
    const live = writeSession(dir, "sub-live.jsonl", { parentSession: "p" }, 2 * DAY_MS);

    const found = scanArchivableSessions(dir, DAY_MS);

    expect(found.map(s => s.path)).toEqual([live]);
  });

  it("requires strictly more idle time than maxAgeMs", () => {
    // The boundary itself is millisecond-sharp, so the
    // test pins the strictness with a margin instead of an exact equality.
    writeSession(dir, "sub-young.jsonl", { parentSession: "p" }, DAY_MS - 5_000);
    const old = writeSession(dir, "sub-old.jsonl", { parentSession: "p" }, DAY_MS + 5_000);

    const found = scanArchivableSessions(dir, DAY_MS);

    expect(found.map(s => s.path)).toEqual([old]);
    expect(found[0].modifiedMs).toBeLessThan(Date.now() - DAY_MS);
  });

  it("returns an empty list for a missing session dir", () => {
    expect(scanArchivableSessions(join(dir, "no-such-dir"), DAY_MS)).toEqual([]);
  });
});

describe("archiveSessions", () => {
  let dir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-session-archive-"));
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("moves stale subagent sessions into archive/ and leaves main alone", () => {
    const mainPath = writeSession(dir, "main.jsonl", {}, 2 * DAY_MS);
    const subPath = writeSession(dir, "sub.jsonl", { parentSession: "p" }, 2 * DAY_MS);

    const result = archiveSessions(dir, DAY_MS);

    expect(result.archived).toEqual([subPath]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(subPath)).toBe(false);
    expect(readFileSync(join(dir, ARCHIVE_DIR_NAME, "sub.jsonl"), "utf8")).toContain("\"parentSession\"");
    expect(existsSync(mainPath)).toBe(true);
  });

  it("never overwrites an existing name in archive/ — the source is skipped", () => {
    const subPath = writeSession(dir, "sub.jsonl", { parentSession: "p" }, 2 * DAY_MS);
    mkdirSync(join(dir, ARCHIVE_DIR_NAME));
    const existing = join(dir, ARCHIVE_DIR_NAME, "sub.jsonl");
    writeFileSync(existing, "ORIGINAL ARCHIVE CONTENT", "utf8");

    const result = archiveSessions(dir, DAY_MS);

    expect(result.archived).toEqual([]);
    expect(result.skipped).toEqual([subPath]);
    expect(readFileSync(existing, "utf8")).toBe("ORIGINAL ARCHIVE CONTENT");
    expect(existsSync(subPath)).toBe(true);
  });

  it("dryRun reports the moves without creating archive/ or moving anything", () => {
    const subPath = writeSession(dir, "sub.jsonl", { parentSession: "p" }, 2 * DAY_MS);
    const mainPath = writeSession(dir, "main.jsonl", {}, 2 * DAY_MS);

    const result = archiveSessions(dir, DAY_MS, { dryRun: true });

    expect(result.archived).toEqual([subPath]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(subPath)).toBe(true);
    expect(existsSync(mainPath)).toBe(true);
    expect(existsSync(join(dir, ARCHIVE_DIR_NAME))).toBe(false);
  });
});

describe("readArchiveConfig", () => {
  let root: string | undefined;
  let projectDir: string | undefined;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-session-archive-cfg-"));
    projectDir = join(root, "proj");
    mkdirSync(projectDir, { recursive: true });
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  });

  afterEach(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    projectDir = undefined;
    previousAgentDir = undefined;
  });

  function globalSettingsPath(): string {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir) throw new Error("PI_CODING_AGENT_DIR not set");
    return join(agentDir, "settings.json");
  }

  function writeSettings(scope: "global" | "project", content: string): void {
    const path = scope === "global" ? globalSettingsPath() : join(projectDir!, ".pi", "settings.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  it("returns undefined when no settings file carries the section", () => {
    expect(readArchiveConfig(projectDir!)).toBeUndefined();
  });

  it("reads enabled with the default maxAgeHours", () => {
    writeSettings("global", JSON.stringify({ "session-archive": { enabled: true } }));
    expect(readArchiveConfig(projectDir!)).toEqual({ enabled: true, maxAgeHours: 24 });
  });

  it("reads maxAgeHours and honors project over global per field", () => {
    writeSettings("global", JSON.stringify({ "session-archive": { enabled: true, maxAgeHours: 48 } }));
    expect(readArchiveConfig(projectDir!)).toEqual({ enabled: true, maxAgeHours: 48 });

    writeSettings("project", JSON.stringify({ "session-archive": { maxAgeHours: 12 } }));
    expect(readArchiveConfig(projectDir!)).toEqual({ enabled: true, maxAgeHours: 12 });
  });

  it("reports disabled config rather than inventing one", () => {
    writeSettings("global", JSON.stringify({ "session-archive": { enabled: false } }));
    expect(readArchiveConfig(projectDir!)).toEqual({ enabled: false, maxAgeHours: 24 });
  });

  it("treats an unreadable or non-object section as absent", () => {
    writeSettings("global", "{ not json");
    expect(readArchiveConfig(projectDir!)).toBeUndefined();

    writeSettings("global", JSON.stringify({ "session-archive": "off" }));
    expect(readArchiveConfig(projectDir!)).toBeUndefined();
  });
});