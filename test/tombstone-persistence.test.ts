/**
 * tombstone-persistence.test.ts — tombstones survive GC, session switches,
 * and process restarts through the fork-owned disk store.
 *
 * Background: completed agents' `.output` transcripts used to live under the
 * OS Temp dir (swept away at reboot), while the in-memory record was GC'd
 * after 10 minutes and tombstones wiped on every session switch — leaving no
 * way back to a finished agent. Tombstones are now:
 *   1. persisted to `<agentDir>/subagent-tombstones.json` on every mutation,
 *   2. reloaded at manager construction (a corrupt file starts empty),
 *   3. kept across `clearCompleted()` (session start/switch),
 *   4. created by GC even for records with no session file (the name is held;
 *      only the reopen is impossible — documented on `AgentTombstone`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const TOMBSTONE_FILE = "subagent-tombstones.json";

let agentDir: string;
let projectDir: string;
let managers: AgentManager[];

beforeEach(() => {
  // Fake Date + setInterval BEFORE constructing the manager: the 60s cleanup
  // timer is armed in the constructor, and GC is driven by advancing time.
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  agentDir = mkdtempSync(join(tmpdir(), "pi-tomb-persist-agent-"));
  projectDir = mkdtempSync(join(tmpdir(), "pi-tomb-persist-proj-"));
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
  // Production enables the disk mirror via the extension; unit managers opt
  // in here so persistence is exercised against the mocked agent dir.
  m.enableTombstonePersistence();
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

/** Past the 10-minute cutoff: the real GC evicts the record into a tombstone. */
async function gc() {
  await vi.advanceTimersByTimeAsync(11 * 60_000);
}

const tombstoneFile = () => join(agentDir, TOMBSTONE_FILE);
const readStore = () => JSON.parse(readFileSync(tombstoneFile(), "utf-8")) as any[];

describe("tombstone persistence", () => {
  it("GC tombstones a completed record and persists it to disk", async () => {
    const sessionFile = join(projectDir, "agent-session.jsonl");
    writeFileSync(sessionFile, "");
    const m = track(new AgentManager());
    const id = await spawnCompleted(m, fakeSession(sessionFile));
    const handle = m.getRecord(id)!.handle!;
    expect(handle).toBeTruthy();

    await gc();

    expect(m.getRecord(id)).toBeUndefined();
    expect(m.listTombstones()).toHaveLength(1);
    expect(m.listTombstones()[0]).toMatchObject({ handle, id, sessionFile });
    // The disk mirror carries the same entry.
    expect(existsSync(tombstoneFile())).toBe(true);
    expect(readStore()).toMatchObject([{ handle, id, sessionFile }]);
  });

  it("a fresh manager reloads tombstones from disk (restart survival)", async () => {
    const sessionFile = join(projectDir, "agent-session.jsonl");
    writeFileSync(sessionFile, "");
    const m = track(new AgentManager());
    const id = await spawnCompleted(m, fakeSession(sessionFile));
    const handle = m.getRecord(id)!.handle!;
    await gc();
    expect(readStore()).toHaveLength(1);

    const restarted = track(new AgentManager());
    expect(restarted.listTombstones()).toHaveLength(1);
    const resolved = restarted.resolveMention(handle);
    expect(resolved?.kind).toBe("tombstone");
    if (resolved?.kind === "tombstone") {
      expect(resolved.entry.sessionFile).toBe(sessionFile);
    }
  });

  it("a corrupt tombstone file starts empty instead of throwing", async () => {
    writeFileSync(tombstoneFile(), "not-json{{{");
    let m: AgentManager | undefined;
    expect(() => { m = track(new AgentManager()); }).not.toThrow();
    expect(m!.listTombstones()).toEqual([]);
    // And a non-array payload is equally harmless.
    writeFileSync(tombstoneFile(), JSON.stringify({ handle: "x" }));
    const m2 = track(new AgentManager());
    expect(m2.listTombstones()).toEqual([]);
  });

  it("GC tombstones records without a session file too (name held, not resumable)", async () => {
    const m = track(new AgentManager());
    const id = await spawnCompleted(m, fakeSession());
    const handle = m.getRecord(id)!.handle!;
    expect(m.getRecord(id)!.sessionFile).toBeUndefined();

    await gc();

    expect(m.getRecord(id)).toBeUndefined();
    const entries = m.listTombstones();
    expect(entries).toHaveLength(1);
    expect(entries[0].handle).toBe(handle);
    expect(entries[0].sessionFile).toBeUndefined();
    // Still addressable by name (takenHandles), still on disk.
    expect(m.resolveMention(handle)?.kind).toBe("tombstone");
    expect(readStore()).toHaveLength(1);
  });

  it("clearCompleted keeps tombstones across session boundaries", async () => {
    const sessionFile = join(projectDir, "agent-session.jsonl");
    writeFileSync(sessionFile, "");
    const m = track(new AgentManager());
    await spawnCompleted(m, fakeSession(sessionFile));
    await gc();
    expect(m.listTombstones()).toHaveLength(1);

    // What session_start / session_before_switch call — must not wipe them.
    m.clearCompleted(true);
    m.clearCompleted(false);

    expect(m.listTombstones()).toHaveLength(1);
    expect(readStore()).toHaveLength(1);
    // A restart after the switch still sees them.
    expect(track(new AgentManager()).listTombstones()).toHaveLength(1);
  });

  it("explicit drops remove tombstones from memory and disk", async () => {
    const m = track(new AgentManager());
    const idA = await spawnCompleted(m, fakeSession());
    const idB = await spawnCompleted(m, fakeSession());
    const handleA = m.getRecord(idA)!.handle!;
    const handleB = m.getRecord(idB)!.handle!;
    await gc();
    expect(m.listTombstones()).toHaveLength(2);

    m.dropTombstone(handleA);
    expect(m.listTombstones().map(t => t.handle)).toEqual([handleB]);
    expect(readStore().map((t: any) => t.handle)).toEqual([handleB]);

    m.clearTombstones();
    expect(m.listTombstones()).toEqual([]);
    expect(readStore()).toEqual([]);
  });

  it("caps the store at MAX_TOMBSTONES=1000, oldest first", async () => {
    const m = track(new AgentManager());
    for (let i = 0; i < 1001; i++) {
      await spawnCompleted(m, fakeSession());
    }
    // No timer wait: clearCompleted evicts every completed record at once.
    m.clearCompleted();
    expect(m.listTombstones()).toHaveLength(1000);
    expect(readStore()).toHaveLength(1000);
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
