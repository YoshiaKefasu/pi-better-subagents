/**
 * session-persistence.test.ts (file name kept from `tombstone-persistence.test.ts`)
 * — what a finished agent leaves behind, and how long the in-memory half lasts.
 *
 * The tombstone store this file used to pin is gone: a finished agent's
 * conversation lives on disk (the pi session file, `archive/` after 24h idle,
 * the `.output` transcript), and the manager keeps only a small record for
 * 24 hours — its live session released after 10 minutes. So there is nothing to
 * mirror, reload or cap, and this file pins those two bounds instead, plus the
 * `.output` placement that makes the on-disk half findable.
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentDir = vi.hoisted(() => ({ value: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => mockAgentDir.value,
}));

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { createOutputFilePath, encodeCwd, sessionTaskDir } from "../src/output-file.js";

const mockPi = {} as any;
/** Name the tombstone store used to own. It must never be written again. */
const TOMBSTONE_FILE = "subagent-tombstones.json";

const MINUTE = 60_000;
const TEN_MINUTES = 10 * MINUTE;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The manager's cleanup cadence — one sweep per tick. */
const TICK = 60_000;

let agentDir: string;
let projectDir: string;
let managers: AgentManager[];

beforeEach(() => {
  // Fake Date + setInterval BEFORE constructing the manager: the cleanup
  // interval is started in the constructor, and both bounds are driven by
  // advancing time.
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  agentDir = mkdtempSync(join(tmpdir(), "pi-sess-persist-agent-"));
  projectDir = mkdtempSync(join(tmpdir(), "pi-sess-persist-proj-"));
  mockAgentDir.value = agentDir;
  managers = [];
});

afterEach(() => {
  for (const m of managers) m.dispose();
  managers = [];
  vi.useRealTimers();
  mockAgentDir.value = "";
  vi.clearAllMocks();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function track(m: AgentManager): AgentManager {
  managers.push(m);
  return m;
}

/** Enough of an AgentSession for spawn settle + GC teardown. */
function fakeSession(sessionFile?: string) {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    ...(sessionFile ? { sessionManager: { getSessionFile: () => sessionFile } } : {}),
  } as any;
}

/** A runAgent that finishes immediately, optionally carrying a session file. */
function finishedRun(session: any, text = "done") {
  vi.mocked(runAgent).mockImplementationOnce(async (_ctx: any, _type: any, _prompt: any, options: any) => {
    options.onSessionCreated?.(session);
    return { responseText: text, session, aborted: false, steered: false, failure: undefined };
  });
}

async function spawnCompleted(m: AgentManager, session?: any): Promise<string> {
  finishedRun(session ?? fakeSession());
  const id = m.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "do work", {
    description: "work",
    isBackground: true,
  });
  await m.getRecord(id)!.promise;
  return id;
}

describe("finished-record retention", () => {
  it("keeps the record for 24 hours but releases its session at 10 minutes", async () => {
    const m = track(new AgentManager());
    const sessionFile = join(projectDir, "agent-session.jsonl");
    writeFileSync(sessionFile, "");
    const dispose = vi.fn();
    const id = await spawnCompleted(m, fakeSession(sessionFile));
    const record = m.getRecord(id)!;
    record.session = { dispose, sessionManager: { getSessionFile: () => sessionFile } } as any;
    const handle = record.handle!;
    expect(handle).toBeTruthy();
    // Past the 10-minute detach, well inside the 24-hour retention.
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    // Record (and therefore the handle) survived; the expensive half did not.
    expect(m.getRecord(id)).toBeDefined();
    expect(record.session).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
    // The file path the conversation lives at is still on the record, which is
    // exactly what a resume reopens.
    expect(record.sessionFile).toBe(sessionFile);
    expect(m.resolveMention(handle)).toMatchObject({ kind: "live", record: { id } });
  });

  it("reaps the record only after the 24-hour window", async () => {
    const m = track(new AgentManager());
    const id = await spawnCompleted(m, fakeSession());
    const record = m.getRecord(id)!;
    record.completedAt = Date.now() - (DAY - 2 * TICK);

    await vi.advanceTimersByTimeAsync(TICK);

    // Just inside the window: still there.
    expect(m.getRecord(id)).toBeDefined();

    record.completedAt = Date.now() - (DAY + 30_000);
    await vi.advanceTimersByTimeAsync(TICK);

    expect(m.getRecord(id)).toBeUndefined();
    expect(m.listAgents().map(a => a.id)).not.toContain(id);
  });

  it("never reaps or detaches a running agent, however old its timestamp looks", async () => {
    // A live agent's session being disposed mid-run is the worst failure the
    // running/queued guard prevents, and `completedAt` on a running record is
    // meaningless.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const m = track(new AgentManager());
    const id = m.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "live", {
      description: "live",
      isBackground: true,
    });
    const record = m.getRecord(id)!;
    expect(record.status).toBe("running");
    record.completedAt = Date.now() - 10 * DAY;
    const dispose = vi.fn();
    record.session = { dispose } as any;

    await vi.advanceTimersByTimeAsync(2 * TICK);

    expect(m.getRecord(id)).toBeDefined();
    expect(record.session).toBeDefined();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("holds the handle while the record lives and frees it once it is gone", async () => {
    const m = track(new AgentManager());
    const first = await spawnCompleted(m, fakeSession());
    m.getRecord(first)!.completedAt = Date.now() - (TEN_MINUTES + 30_000);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(m.getRecord(first)!.handle).toBe("general-purpose");

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const second = m.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "second", {
      description: "second",
      isBackground: true,
    });
    // The finished record still owns the name, so the new one is numbered.
    expect(m.getRecord(second)!.handle).toBe("general-purpose-2");

    // Past retention the name is free again — and the conversation is not lost
    // with it: the disk copy is what a resume reopens.
    m.getRecord(first)!.completedAt = Date.now() - (DAY + 30_000);
    await vi.advanceTimersByTimeAsync(TICK);
    const third = m.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "third", {
      description: "third",
      isBackground: true,
    });
    expect(m.getRecord(third)!.handle).toBe("general-purpose");
  });

  it("clearCompleted drops finished records from memory at a session boundary", async () => {
    const m = track(new AgentManager());
    const a = await spawnCompleted(m, fakeSession());
    const b = await spawnCompleted(m, fakeSession());
    m.getRecord(a)!.resultConsumed = true;
    m.getRecord(b)!.resultConsumed = true;
    expect(m.listAgents()).toHaveLength(2);

    // What session_start / session_before_switch call.
    m.clearCompleted(true);

    expect(m.getRecord(a)).toBeUndefined();
    expect(m.getRecord(b)).toBeUndefined();
    expect(m.listAgents()).toEqual([]);
  });

  it("clearCompleted(false) drops everything, consumed or not", async () => {
    const m = track(new AgentManager());
    const a = await spawnCompleted(m, fakeSession());
    const b = await spawnCompleted(m, fakeSession());
    m.getRecord(a)!.resultConsumed = false;
    m.getRecord(b)!.resultConsumed = false;

    m.clearCompleted(false);

    expect(m.listAgents()).toEqual([]);
  });

  it("clearCompleted keeps results the LLM has not read yet", async () => {
    const m = track(new AgentManager());
    const unread = await spawnCompleted(m, fakeSession());
    m.getRecord(unread)!.resultConsumed = false;
    const read = await spawnCompleted(m, fakeSession());
    m.getRecord(read)!.resultConsumed = true;

    m.clearCompleted(true);

    expect(m.getRecord(unread)).toBeDefined();
    expect(m.getRecord(read)).toBeUndefined();
  });

  it("writes no tombstone store — the conversations live on disk", () => {
    // The debloat's regression pin: nothing mirrors records to a side file, so
    // nothing has to be reloaded, shape-validated or capped. A stale file left
    // by an older version is simply never read again.
    expect(existsSync(join(agentDir, TOMBSTONE_FILE))).toBe(false);
    expect(existsSync(join(agentDir, TOMBSTONE_FILE))).toBe(false);
  });

  it("resolves a finished record by a unique id prefix", async () => {
    const m = track(new AgentManager());
    const id = await spawnCompleted(m, fakeSession());
    expect(m.resolveRecord(id.slice(0, 8))?.id).toBe(id);
    expect(m.resolveRecord(id.slice(0, 8)).type).toBe("general-purpose");
  });
});

describe(".output placement outside Temp", () => {
  it("builds the documented layout under <agentDir>/tmp/subagents-output", () => {
    const path = createOutputFilePath("/home/user/project", "agent-xyz", "session-123");
    expect(path).toBe(
      join(agentDir, "tmp", "subagents-output", encodeCwd("/home/user/project"), "session-123", "tasks", "agent-xyz.output"),
    );
    // Regression: the old `$TMPDIR/pi-subagents-<uid>` root is gone.
    expect(path).not.toContain("pi-subagents-");
  });

  it("creates the directory chain so the first write cannot fail", () => {
    const path = createOutputFilePath("/home/user/project", "agent-xyz", "session-123");
    expect(existsSync(sessionTaskDir("/home/user/project", "session-123"))).toBe(true);
    expect(path.endsWith("agent-xyz.output")).toBe(true);
  });

  it.skipIf(process.platform === "win32")("keeps the fork-owned root owner-only", () => {
    createOutputFilePath("/home/user/project", "agent-xyz", "session-123");
    expect(statSync(join(agentDir, "tmp", "subagents-output")).mode & 0o777).toBe(0o700);
  });
});
