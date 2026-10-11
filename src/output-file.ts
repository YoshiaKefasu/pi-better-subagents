/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type AgentSession, type AgentSessionEvent, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Project/global default for writing a subagent's `.output` transcript; a custom
 * agent's `output_transcript` overrides it per agent.
 *
 * State lives here rather than in an index.ts closure because both spawn paths
 * need it — the top-level Agent tool and the nested delegation tools. Same
 * reason `scopeModels` lives in model-scope.ts: a setting only one path can read
 * is a setting the other path silently ignores.
 */
let outputTranscriptDefault = true;

export function getOutputTranscriptDefault(): boolean { return outputTranscriptDefault; }
export function setOutputTranscriptDefault(b: boolean): void { outputTranscriptDefault = b; }

/**
 * Encode a cwd path as a filesystem-safe directory name. Handles:
 *   - POSIX:   "/home/user/project"        → "home-user-project"
 *   - Windows: "C:\Users\foo\project"      → "Users-foo-project"
 *   - UNC:     "\\\\server\\share\\project"  → "server-share-project"
 */
export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, "-")        // both separators → dash
    .replace(/^[A-Za-z]:-/, "")    // strip Windows drive prefix ("C:-")
    .replace(/^-+/, "");           // strip leading dashes (POSIX root, UNC)
}

/**
 * The per-session scratch directory, created if missing.
 * Mirrors Claude Code's layout: {root}/{encoded-cwd}/{sessionId}/tasks
 *
 * The root used to be `$TMPDIR/pi-subagents-<uid>` — completed agents'
 * `.output` transcripts vanished whenever the OS swept Temp, and together
 * with the in-memory GC that left no way back to a finished agent. The root
 * is now fork-owned under pi's agent dir (`getAgentDir()/tmp/
 * subagents-output`), which survives reboots and Temp sweeps. `tmp/` itself
 * is shared space (created if missing, permissions untouched); only the
 * fork-owned `subagents-output` root below it is tightened to owner-only
 * `0700`, since transcripts hold full conversation text.
 *
 * Shared with the workflow tool, which persists each invocation's script here so
 * iterating on one is edit-file-then-rerun — the same convention, one directory.
 *
 * ディスク増加は緩やか: JSONL 追記のみでローテーションは pi 本体のセッション
 * 保持方針に従う（古い Temp 側ファイルの移行はしない。新規分から新配置）。
 */
export function sessionTaskDir(cwd: string, sessionId: string): string {
  const encoded = encodeCwd(cwd);
  // getAgentDir()配下: fork 所有の tmp/subagents-output。tmp/ は他と共有し得る
  // ため chmod しない（作るだけ）。0700 に締めるのは subagents-output 以下のみ。
  mkdirSync(join(getAgentDir(), "tmp"), { recursive: true });
  const root = join(getAgentDir(), "tmp", "subagents-output");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // chmod is a no-op on Windows and throws on some Windows filesystems.
  // On Unix we still want to enforce 0o700 past umask, so only swallow on Windows.
  try {
    chmodSync(root, 0o700);
  } catch (err) {
    if (process.platform !== "win32") throw err;
  }
  const dir = join(root, encoded, sessionId, "tasks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create the output file path, ensuring the directory exists. */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  return join(sessionTaskDir(cwd, sessionId), `${agentId}.output`);
}

/**
 * Ensure a transcript file exists without disturbing what is already in it.
 *
 * A resume reuses the agent's existing transcript (same deterministic path), so
 * it must never call `writeInitialEntry` — that truncates, discarding turns the
 * completion notification still points the user at, and any history the session
 * has since compacted away is gone for good. Appending nothing creates the file
 * when this is the agent's first transcript and is a no-op when it is not.
 */
export function ensureOutputFile(path: string): void {
  try {
    appendFileSync(path, "", "utf-8");
  } catch { /* ignore — streaming writes are best-effort too */ }
}

/** Write the initial user prompt entry. */
export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
  startIndex?: number,
): () => void {
  // Index of the first message this stream is responsible for. A spawn writes
  // messages[0] as the initial prompt entry, so it starts at 1. A resume hands
  // in the session's length as of just before the run: the session already
  // holds every prior turn, and re-emitting those would duplicate history that
  // is already in the file.
  let writtenCount = startIndex ?? 1;

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      const entry = {
        isSidechain: true,
        agentId,
        type: msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : "toolResult",
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      try {
        appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
      } catch { /* ignore write errors */ }
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
    // Compaction replaces session.messages with a shorter, summarized array,
    // leaving writtenCount past the new end — without re-anchoring, the flush
    // loop would never match again and streaming would halt for good (#145).
    // Flush before it runs so any not-yet-flushed tail still reaches the file,
    // then re-anchor to the rebuilt array once it lands. The re-anchor is
    // deferred a microtask because on the overflow-retry path pi trims the
    // trailing error assistant message AFTER emitting compaction_end —
    // anchoring synchronously would sit one past the trimmed array and skip
    // the first post-compaction message. Aborted/failed compactions leave
    // session.messages untouched, so only successful ones re-anchor.
    if (event.type === "compaction_start") flush();
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      queueMicrotask(() => { writtenCount = session.messages.length; });
    }
  });

  return () => {
    flush();
    unsubscribe();
  };
}

// ---- Recovering a pi session from a transcript ----

/**
 * One parsed `.output` line. `message` is the pi message the stream copied
 * verbatim (`role` of `user` / `assistant` / `toolResult`), so a recovered
 * session holds the same shapes a live session would.
 */
interface OutputEntry {
  agentId?: string;
  message?: { role?: unknown; content?: unknown } & Record<string, unknown>;
  timestamp?: unknown;
}

/** Pi session entry ids are 8 random hex chars, unique within the file. */
function generateEntryId(used: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!used.has(id)) { used.add(id); return id; }
  }
  const fallback = randomUUID().replace(/-/g, "").slice(0, 8);
  used.add(fallback);
  return fallback;
}

/** Session header ids must satisfy pi's `assertValidSessionId`. */
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function safeSessionId(agentId: string): string {
  if (SESSION_ID_RE.test(agentId)) return agentId;
  const cleaned = agentId
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9]+$/, "");
  if (cleaned && SESSION_ID_RE.test(cleaned)) return cleaned;
  return randomUUID().replace(/-/g, "");
}

/**
 * Mirror of pi's own session-dir encoding (`getDefaultSessionDirPath`):
 * `--<cwd with / \ : turned into dashes>--`. NOT {@link encodeCwd}, which
 * drops the Windows drive prefix — pi keeps it, so a recovered session has to
 * land in the directory pi's `SessionManager.list(cwd)` actually scans.
 */
function piSessionDir(cwd: string): string {
  const stripped = cwd.replace(/^[/\\]/, "");
  const safe = `--${stripped.split(/[/\\:]/).join("-")}--`;
  return join(getAgentDir(), "sessions", safe);
}

/**
 * Turn transcript lines into the messages a recovered session should carry.
 *
 * Two repairs, both about what a transcript can legitimately end (or start)
 * with and what the provider API will not accept on the next request:
 *
 *  - A duplicate first prompt. `writeInitialEntry` writes the prompt as a
 *    plain string, and a spawn that reopens an existing session re-emits that
 *    same prompt from `session.messages` — so line 0 can be the prompt twice.
 *    Skipping the initial entry when line 1 is already a user message keeps
 *    one copy; with no second line the string is normalized into the
 *    `content` array pi uses everywhere else.
 *  - Unresolved tool calls. A transcript written while a tool was running (or
 *    from an aborted turn) ends on an assistant message whose `toolCall` has
 *    no matching `toolResult`. Resuming that verbatim makes the provider
 *    reject the whole request over `tool_call_id` mismatch, so those calls are
 *    dropped; an assistant message left with nothing at all is dropped too,
 *    which is also what an `stopReason: "aborted"` empty turn needs.
 */
function recoverMessages(entries: OutputEntry[]): Record<string, unknown>[] {
  const start = entries.length > 1
    && entries[0]?.message?.role === "user"
    && typeof entries[0]?.message?.content === "string"
    && entries[1]?.message?.role === "user"
    ? 1
    : 0;

  const seen = entries.slice(start);
  const answered = new Set<string>();
  for (const entry of seen) {
    const m = entry.message as { role?: unknown; toolCallId?: unknown } | undefined;
    if (m?.role === "toolResult" && typeof m.toolCallId === "string") answered.add(m.toolCallId);
  }

  const out: Record<string, unknown>[] = [];
  for (const entry of seen) {
    const m = entry.message as Record<string, unknown> | undefined;
    if (!m || typeof m.role !== "string") continue;
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult") continue;
    if (m.role === "user" && typeof m.content === "string") {
      out.push({ ...m, content: [{ type: "text", text: m.content }] });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const kept = m.content.filter((part) => {
        const p = part as { type?: unknown; id?: unknown };
        return !(p?.type === "toolCall" && typeof p.id === "string" && !answered.has(p.id));
      });
      // Nothing usable left (e.g. an aborted turn whose only content was the
      // pending tool call) — drop the entry rather than send an empty turn.
      if (kept.length === 0) continue;
      out.push(kept.length === m.content.length ? m : { ...m, content: kept });
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Rebuild a pi session (v3 `.jsonl`) from an agent's `.output` transcript.
 *
 * Why this exists: `rememberAgents: false` — or any run whose session was
 * in-memory — leaves records whose `sessionFile` is `undefined`. Once such a
 * record is reaped (24h retention, a session switch, a fresh process) nothing
 * in memory points at the conversation any more, so without this an
 * `Agent({ resume })` would answer `Agent not found` while the full transcript
 * is still sitting on disk. The transcript carries every message the session
 * had, so a session can be rebuilt from it.
 *
 * Writes `<sessionDir or pi's dir for cwd>/recovered-<agentId>.jsonl` and
 * returns that path. An existing recovered file is reused while it is at least
 * as new as the transcript it came from, so repeated resumes of the same agent
 * do not keep rewriting history that has already grown past it.
 *
 * Returns `undefined` when the transcript is missing, unreadable, or holds no
 * recoverable message — the caller then falls through to `Agent not found`.
 */
export function materializeSessionFromOutputFile(
  outputPath: string,
  cwd: string,
  sessionDir?: string,
  agentType?: string,
): string | undefined {
  if (!existsSync(outputPath)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(outputPath, "utf-8");
  } catch {
    return undefined;
  }
  const entries: OutputEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as OutputEntry;
      if (parsed && typeof parsed === "object") entries.push(parsed);
    } catch {
      /* one torn line (a half-flushed append) must not cost the whole rebuild */
    }
  }
  const messages = recoverMessages(entries);
  if (messages.length === 0) return undefined;

  const agentId = entries[0]?.agentId ?? basename(outputPath).replace(/\.output$/, "");
  const dir = sessionDir ?? piSessionDir(cwd);
  const target = join(dir, `recovered-${safeSessionId(agentId)}.jsonl`);

  // Reuse an existing recovery unless the transcript has moved on since.
  try {
    if (statSync(target).mtimeMs >= statSync(outputPath).mtimeMs) return target;
  } catch {
    /* no existing file, or it vanished — regenerate below */
  }

  const headerTimestamp = entries[0]?.timestamp;
  const headerTime = typeof headerTimestamp === "string" ? headerTimestamp : new Date().toISOString();
  const sessionName = `${agentType ?? "general-purpose"}#${agentId.slice(0, 8)}`;
  const usedIds = new Set<string>();
  const lines: string[] = [
    JSON.stringify({ type: "session", version: 3, id: safeSessionId(agentId), timestamp: headerTime, cwd }),
    JSON.stringify({ type: "session_info", id: generateEntryId(usedIds), parentId: null, timestamp: headerTime, name: sessionName }),
  ];
  let parentId: string | null = null;
  for (const message of messages) {
    const entryTimestamp = typeof message.timestamp === "number"
      ? new Date(message.timestamp).toISOString()
      : new Date().toISOString();
    const id = generateEntryId(usedIds);
    lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: entryTimestamp, message }));
    parentId = id;
  }

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");
  } catch {
    return undefined;
  }
  return target;
}

/** The fork-owned transcript root: `<agentDir>/tmp/subagents-output`. */
export function outputTranscriptRoot(): string {
  return join(getAgentDir(), "tmp", "subagents-output");
}

/**
 * Every transcript under the root, as `{ path, agentId }`.
 *
 * Walks the documented layout (`<root>/<encoded-cwd>/<sessionId>/tasks/<agentId>.output`)
 * level by level rather than with a recursive readdir: the depth is fixed, and
 * one unreadable directory should not cost the whole scan.
 */
export function listOutputFiles(): { path: string; agentId: string }[] {
  const out: { path: string; agentId: string }[] = [];
  const root = outputTranscriptRoot();
  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => join(root, d.name));
  } catch {
    return out;
  }
  for (const cwdDir of cwdDirs) {
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(cwdDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => join(cwdDir, d.name));
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const tasksDir = join(sessionDir, "tasks");
      try {
        for (const f of readdirSync(tasksDir)) {
          if (!f.endsWith(".output")) continue;
          out.push({ path: join(tasksDir, f), agentId: f.replace(/\.output$/, "") });
        }
      } catch {
      }
    }
  }
  return out;
}

/**
 * Find an agent's transcript by full id, or by a unique prefix of at least
 * {@link MIN_ID_PREFIX_LEN} characters — the same rule `resolveRecord` and
 * `findSessionOnDisk` apply, so `480c2bd8` reaches the same agent everywhere.
 * An ambiguous prefix is refused rather than guessed.
 */
const MIN_ID_PREFIX_LEN = 6;

export function findOutputFile(id: string): string | undefined {
  const wanted = id.toLowerCase().trim();
  if (!wanted) return undefined;
  const files = listOutputFiles();
  const exact = files.find((f) => f.agentId.toLowerCase() === wanted);
  if (exact) return exact.path;
  if (wanted.length < MIN_ID_PREFIX_LEN) return undefined;
  const matches = files.filter((f) => f.agentId.toLowerCase().startsWith(wanted));
  return matches.length === 1 ? matches[0].path : undefined;
}
