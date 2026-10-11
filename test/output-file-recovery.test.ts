/**
 * output-file-recovery.test.ts — rebuilding a pi session from a `.output`
 * transcript, and finding the transcript that belongs to an agent id.
 *
 * The case these cover: a run whose session was never persisted
 * (`rememberAgents: false`) leaves a record with no `sessionFile`. GC then
 * evicts it into a tombstone that looks unreopenable, and dropping that
 * tombstone leaves `Agent({ resume })` answering `Agent not found` while the
 * conversation is still on disk. `materializeSessionFromOutputFile` is the
 * piece that turns the transcript back into something resumable, and
 * `findOutputFile` is how a short id (or a prefix) reaches it.
 *
 * `PI_CODING_AGENT_DIR` is redirected per test because `getAgentDir()` reads
 * it on every call — no module mock needed.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findOutputFile,
  listOutputFiles,
  materializeSessionFromOutputFile,
  outputTranscriptRoot,
  sessionTaskDir,
} from "../src/output-file.js";

let agentDir: string;
let prevAgentDir: string | undefined;

/** The documented transcript layout, one level at a time. */
function writeTranscript(cwd: string, sessionId: string, agentId: string, lines: unknown[]): string {
  const dir = sessionTaskDir(cwd, sessionId);
  const path = join(dir, `${agentId}.output`);
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf-8");
  return path;
}

/** One `.output` line, in the shape `streamToOutputFile` writes. */
function line(agentId: string, message: Record<string, unknown>) {
  return { isSidechain: true, agentId, type: message.role, message, timestamp: new Date().toISOString(), cwd: "/proj" };
}

function readJsonl(path: string): Record<string, any>[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = mkdtempSync(join(tmpdir(), "pi-recovery-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const AGENT = "480c2bd8-98c0-4a57-b89a-29ce5a3fec22";
const OTHER = "31c950e9-1111-4222-8333-444455556666";

describe("materializeSessionFromOutputFile", () => {
  it("writes a pi v3 session: header, session_info, parentId-chained messages", () => {
    const path = writeTranscript("/home/u/proj", "s1", AGENT, [
      // writeInitialEntry's shape — a plain string prompt.
      { isSidechain: true, agentId: AGENT, type: "user", message: { role: "user", content: "find flaky tests" }, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/proj" },
      line(AGENT, { role: "assistant", content: [{ type: "text", text: "looking" }], stopReason: "stop", timestamp: 1 }),
    ]);

    const recovered = materializeSessionFromOutputFile(path, "/home/u/proj", undefined, "Explore");
    expect(recovered).toBeDefined();
    expect(recovered!.endsWith("recovered-" + AGENT + ".jsonl")).toBe(true);

    const entries = readJsonl(recovered!);
    expect(entries[0]).toMatchObject({ type: "session", version: 3, id: AGENT, cwd: "/home/u/proj" });
    expect(entries[1]).toMatchObject({ type: "session_info", parentId: null, name: "Explore#480c2bd8" });
    // Messages start at entry 2, and each parentId is the previous id.
    expect(entries[2].type).toBe("message");
    expect(entries[2].parentId).toBeNull();
    expect(entries[3].parentId).toBe(entries[2].id);
    expect(entries[3].id).not.toBe(entries[2].id);
    // A string prompt is normalized to the content array pi uses everywhere.
    expect(entries[2].message).toEqual({ role: "user", content: [{ type: "text", text: "find flaky tests" }] });
    expect(entries[3].message).toMatchObject({ role: "assistant" });
  });

  it("skips the duplicated initial prompt when line 2 is already a user message", () => {
    const path = writeTranscript("/proj", "s1", AGENT, [
      { isSidechain: true, agentId: AGENT, type: "user", message: { role: "user", content: "same prompt" }, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/proj" },
      line(AGENT, { role: "user", content: [{ type: "text", text: "same prompt" }], timestamp: 2 }),
      line(AGENT, { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 3 }),
    ]);

    const entries = readJsonl(materializeSessionFromOutputFile(path, "/proj")!);
    const messages = entries.filter((e) => e.type === "message");
    expect(messages).toHaveLength(2);
    expect(messages[0].message.content).toEqual([{ type: "text", text: "same prompt" }]);
    expect(messages[1].message).toMatchObject({ role: "assistant" });
  });

  it("drops a trailing toolCall with no result so a resume cannot hit a tool_call_id mismatch", () => {
    const path = writeTranscript("/proj", "s1", AGENT, [
      line(AGENT, { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }),
      line(AGENT, {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
          { type: "toolCall", id: "call-2", name: "read", arguments: {} },
        ],
        stopReason: "toolUse",
        timestamp: 2,
      }),
      line(AGENT, { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 }),
    ]);

    const entries = readJsonl(materializeSessionFromOutputFile(path, "/proj")!);
    const messages = entries.filter((e) => e.type === "message");
    const assistant = messages.find((m) => m.message.role === "assistant")!;
    // Only the answered call survives; the text block is kept.
    expect(assistant.message.content).toEqual([
      { type: "text", text: "on it" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
    ]);
    // ...and the last message is not an assistant turn holding a dangling call.
    expect(messages[messages.length - 1].message.role).toBe("toolResult");
  });

  it("drops an aborted assistant entry whose only content was the pending call", () => {
    const path = writeTranscript("/proj", "s1", AGENT, [
      line(AGENT, { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }),
      line(AGENT, { role: "assistant", content: [{ type: "toolCall", id: "lost", name: "bash", arguments: {} }], stopReason: "aborted", timestamp: 2 }),
    ]);

    const entries = readJsonl(materializeSessionFromOutputFile(path, "/proj")!);
    const messages = entries.filter((e) => e.type === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0].message.role).toBe("user");
  });

  it("drops an empty aborted assistant turn as well", () => {
    const path = writeTranscript("/proj", "s1", AGENT, [
      line(AGENT, { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }),
      line(AGENT, { role: "assistant", content: [], stopReason: "aborted", timestamp: 2 }),
    ]);
    const entries = readJsonl(materializeSessionFromOutputFile(path, "/proj")!);
    expect(entries.filter((e) => e.type === "message")).toHaveLength(1);
  });

  it("lands in pi's own session dir for the cwd, which keeps the drive letter", () => {
    // Not `encodeCwd`: pi names the dir `--C--Users-u-proj--`, and a recovered
    // session in any other directory is invisible to `SessionManager.list`.
    const path = writeTranscript("C:\\Users\\u\\proj", "s1", AGENT, [
      line(AGENT, { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }),
    ]);

    const recovered = materializeSessionFromOutputFile(path, "C:\\Users\\u\\proj")!;
    const expected = join(agentDir, "sessions", "--C--Users-u-proj--", `recovered-${AGENT}.jsonl`);
    expect(recovered).toBe(expected);
    expect(existsSync(recovered)).toBe(true);
  });

  it("honours an explicit session dir over the computed one", () => {
    const custom = mkdtempSync(join(tmpdir(), "pi-recovery-sessiondir-"));
    try {
      const path = writeTranscript("/proj", "s1", AGENT, [
        line(AGENT, { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }),
      ]);
      const recovered = materializeSessionFromOutputFile(path, "/proj", custom)!;
      expect(recovered).toBe(join(custom, `recovered-${AGENT}.jsonl`));
      expect(existsSync(recovered)).toBe(true);
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });

  it("reuses an existing recovery that is newer than the transcript", () => {
    const path = writeTranscript("/proj", "s1", AGENT, [
      line(AGENT, { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }),
    ]);
    const dir = mkdtempSync(join(tmpdir(), "pi-recovery-sessiondir-"));
    try {
      const first = materializeSessionFromOutputFile(path, "/proj", dir)!;
      expect(first).toBeTruthy();
      // Simulate a run that already grew past the transcript: the recovered
      // session is newer, so re-materializing must not rewind it.
      const future = new Date(Date.now() + 60_000);
      utimesSync(first, future, future);

      const again = materializeSessionFromOutputFile(path, "/proj", dir)!;
      expect(again).toBe(first);
      expect(readFileSync(first, "utf-8")).toBe(readFileSync(first, "utf-8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regenerates when the transcript has moved on", () => {
    const path = writeTranscript("/proj", "s1", AGENT, [
      line(AGENT, { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 }),
    ]);
    const dir = mkdtempSync(join(tmpdir(), "pi-recovery-sessiondir-"));
    try {
      const first = materializeSessionFromOutputFile(path, "/proj", dir)!;
      appendFileSync(path, `${JSON.stringify(line(AGENT, { role: "assistant", content: [{ type: "text", text: "later" }], stopReason: "stop", timestamp: 2 }))}\n`);
      const future = new Date(Date.now() + 60_000);
      utimesSync(path, future, future);

      const second = materializeSessionFromOutputFile(path, "/proj", dir)!;
      expect(second).toBe(first);
      expect(readJsonl(second).filter((e) => e.type === "message")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a missing, empty, or unrecoverable transcript", () => {
    expect(materializeSessionFromOutputFile(join(agentDir, "nope.output"), "/proj")).toBeUndefined();
    const empty = join(sessionTaskDir("/proj", "s1"), `${AGENT}.output`);
    writeFileSync(empty, "");
    expect(materializeSessionFromOutputFile(empty, "/proj")).toBeUndefined();
    // A transcript of nothing but torn lines recovers nothing.
    const torn = join(sessionTaskDir("/proj", "s1"), `${OTHER}.output`);
    writeFileSync(torn, '{"isSidechain":true,"agentId"\n');
    expect(materializeSessionFromOutputFile(torn, "/proj")).toBeUndefined();
  });

  it("recovers a single-line transcript (the initial prompt alone)", () => {
    const path = writeTranscript("/proj", "s1", AGENT, [
      { isSidechain: true, agentId: AGENT, type: "user", message: { role: "user", content: "only the prompt" }, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/proj" },
    ]);
    const entries = readJsonl(materializeSessionFromOutputFile(path, "/proj")!);
    expect(entries.filter((e) => e.type === "message")).toHaveLength(1);
    expect(entries[2].message.content).toEqual([{ type: "text", text: "only the prompt" }]);
  });
});

describe("findOutputFile / listOutputFiles", () => {
  it("walks the documented layout under the fork-owned root", () => {
    writeTranscript("/p", "s1", AGENT, [line(AGENT, { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 })]);
    const files = listOutputFiles();
    expect(files).toEqual([{ path: join(outputTranscriptRoot(), "p", "s1", "tasks", `${AGENT}.output`), agentId: AGENT }]);
  });

  it("finds a transcript by exact id", () => {
    const path = writeTranscript("/p", "s1", AGENT, [line(AGENT, { role: "user", content: "go", timestamp: 1 })]);
    expect(findOutputFile(AGENT)).toBe(path);
    // Case-insensitive, like resolveRecord and findSessionOnDisk.
    expect(findOutputFile(AGENT.toUpperCase())).toBe(path);
  });

  it("finds a transcript by a unique prefix (6 chars minimum)", () => {
    const path = writeTranscript("/p", "s1", AGENT, [line(AGENT, { role: "user", content: "go", timestamp: 1 })]);
    expect(findOutputFile("480c2bd8")).toBe(path);
    // Too short to be unambiguous by rule.
    expect(findOutputFile("480c")).toBeUndefined();
    expect(findOutputFile("480c2bd8-98c0")).toBe(path);
  });

  it("refuses an ambiguous prefix rather than guessing", () => {
    const a = writeTranscript("/p", "s1", AGENT, [line(AGENT, { role: "user", content: "go", timestamp: 1 })]);
    const other = "480c2bd8-0000-4000-8000-000000000000";
    const b = writeTranscript("/p", "s1", other, [line(other, { role: "user", content: "go", timestamp: 1 })]);
    expect(a).not.toBe(b);
    expect(findOutputFile("480c2bd8")).toBeUndefined();
    // ...but the full id still resolves to exactly one of them.
    expect(findOutputFile(AGENT)).toBe(a);
    expect(findOutputFile(other)).toBe(b);
  });

  it("returns undefined for an empty or unknown id", () => {
    writeTranscript("/p", "s1", AGENT, [line(AGENT, { role: "user", content: "go", timestamp: 1 })]);
    expect(findOutputFile("")).toBeUndefined();
    expect(findOutputFile("ffffffff")).toBeUndefined();
  });
});
