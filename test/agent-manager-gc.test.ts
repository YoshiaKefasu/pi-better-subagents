// The record reaper (AgentManager.cleanup) has never run in a test: the main
// agent-manager suite uses real timers throughout, and nothing calls the
// private method. Its two stages are load-bearing in opposite directions —
// inverting the retention cutoff reaps records the LLM hasn't read yet, and
// dropping the running/queued skip disposes a LIVE agent's session mid-run.
//
// It lives in its own file because vi.useFakeTimers() has to be installed
// BEFORE `new AgentManager()` (the constructor starts the interval), and fake
// timers are hostile to the promise-settling style of the main suite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const TEN_MINUTES = 10 * 60_000;
/** How long a finished record is kept in memory before the GC reaps it. */
const RECORD_RETAIN_MS = 24 * 60 * 60_000;
const TICK = 60_000;

describe("AgentManager — record GC", () => {
  let manager: AgentManager;

  beforeEach(() => {
    // Before construction: the cleanup interval is started in the constructor.
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  /** Spawn a background agent and settle it, returning its id and record. */
  async function settled(prompt: string) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", prompt, { description: prompt, isBackground: true });
    await manager.getRecord(id)!.promise;
    return { id, record: manager.getRecord(id)! };
  }

  it("keeps a record that completed inside the retention window", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("recent");
    // Age at sweep time is (TEN_MINUTES - 2*TICK) + TICK — just inside the window.
    // Advancing the timers moves Date.now() too, so the margin has to outlast it.
    record.completedAt = Date.now() - (TEN_MINUTES - 2 * TICK);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeDefined();
  });

  it("releases a 10-minute-old record's session but keeps the record", async () => {
    // The first stage of the sweep: the expensive half goes, the bookkeeping
    // stays — and with it the handle, the counts and the two file paths a
    // resume needs.
    manager = new AgentManager();
    const { id, record } = await settled("stale");
    const dispose = vi.fn();
    record.session = { dispose } as any;
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeDefined();
    expect(record.session).toBeUndefined();
    expect(dispose).toHaveBeenCalled();
  });

  it("evicts a record that outlived the 24-hour window and disposes its session", async () => {
    manager = new AgentManager();
    const { id, record } = await settled("stale");
    const dispose = vi.fn();
    record.session = { dispose } as any;
    record.completedAt = Date.now() - (RECORD_RETAIN_MS + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeUndefined();
    expect(manager.listAgents().map(a => a.id)).not.toContain(id);
    expect(dispose).toHaveBeenCalled();
  });

  it("closes the released session's extension lifecycle before disposing it (#242)", async () => {
    // The reported crash, on its own path: this sweep is what fires ~10 min after a
    // subagent finishes. Disposing only invalidates the ExtensionRunner, so whatever
    // an extension armed in `session_start` stayed armed — and its next tick threw
    // `assertActive()` from a bare timer callback, killing interactive pi.
    manager = new AgentManager();
    const { id, record } = await settled("stale");
    const emit = vi.fn(async () => {});
    const dispose = vi.fn();
    record.session = {
      dispose,
      extensionRunner: { hasHandlers: (event: string) => event === "session_shutdown", emit },
    } as any;
    record.completedAt = Date.now() - (TEN_MINUTES + 30_000);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(manager.getRecord(id)).toBeDefined();
    expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    // After dispose() the runner is invalidated and every ctx getter throws, so an
    // emit that landed afterwards would be worse than none.
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]);
  });

  it("never evicts a running agent, however old its timestamp looks", async () => {
    // A live agent's session being disposed mid-run is the worst failure this
    // guard prevents, and `completedAt` on a running record is meaningless.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "live", { description: "live", isBackground: true });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    record.completedAt = Date.now() - 10 * TEN_MINUTES;
    const dispose = vi.fn();
    record.session = { dispose } as any;

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(manager.getRecord(id)).toBeDefined();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("never evicts a queued agent", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager(undefined, 1);
    manager.spawn(mockPi, mockCtx, "X", "holder", { description: "holder", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "X", "waiter", { description: "waiter", isBackground: true });
    const queued = manager.getRecord(queuedId)!;
    expect(queued.status).toBe("queued");
    queued.completedAt = Date.now() - 10 * TEN_MINUTES;

    await vi.advanceTimersByTimeAsync(TICK * 5);

    expect(manager.getRecord(queuedId)?.status).toBe("queued");
  });

  it("sweeps repeatedly, not just once", async () => {
    // The interval must keep firing: a record that ages past the retention
    // window on a later tick has to be collected too.
    manager = new AgentManager();
    const { id, record } = await settled("ages-out");
    record.completedAt = Date.now() - (RECORD_RETAIN_MS - 3 * TICK);

    await vi.advanceTimersByTimeAsync(TICK);
    expect(manager.getRecord(id)).toBeDefined(); // still inside the window

    await vi.advanceTimersByTimeAsync(TICK * 4);
    expect(manager.getRecord(id)).toBeUndefined(); // aged out on a later tick
  });
});

// Eviction is exactly the moment a handle would otherwise stop working. These
// cover what outlives it: enough to find the agent's session on disk and
// reopen the conversation, and the name held so nothing else claims it.
describe("AgentManager — records outliving the GC", () => {
  let manager: AgentManager;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  /** Spawn, settle, and age to `minutes` past completion. */
  async function aged(type: string, prompt: string, minutes: number, sessionFile?: string) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, type, prompt, { description: prompt, isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.sessionFile = sessionFile;
    record.completedAt = Date.now() - minutes * 60_000;
    return { id, record };
  }

  /** One sweep of the 60s cleanup timer. */
  const tick = () => vi.advanceTimersByTimeAsync(TICK);

  it("keeps a finished agent reachable by name while its record lives", async () => {
    // Only the live session is released at 10 minutes; the record (and with it
    // the handle) stays for 24 hours, so `@explore` still addresses it.
    manager = new AgentManager();
    await aged("Explore", "audit the RPC path", TEN_MINUTES / 60_000 + 0.5, "/sessions/explore.jsonl");

    await tick();

    const resolved = manager.resolveMention("explore");
    expect(resolved?.kind).toBe("live");
    expect(resolved).toMatchObject({
      record: { handle: "explore", type: "Explore", description: "audit the RPC path", sessionFile: "/sessions/explore.jsonl" },
    });
  });

  it("still keeps a record whose session was only ever in memory", async () => {
    // In-memory sessions leave no file, so there is no conversation to reopen —
    // but the record is kept for the full window either way: it is what holds
    // the name and answers the widget, and the sweep treats both alike.
    manager = new AgentManager();
    await aged("Explore", "ephemeral", TEN_MINUTES / 60_000 + 0.5);

    await tick();

    const resolved = manager.resolveMention("explore");
    expect(resolved?.kind).toBe("live");
    expect(manager.listAgents()).toHaveLength(1);
    expect(manager.listAgents()[0].sessionFile).toBeUndefined();
  });

  it("holds the finished handle so a later agent of the same type can't shadow it", async () => {
    manager = new AgentManager();
    await aged("Explore", "first", TEN_MINUTES / 60_000 + 0.5, "/sessions/first.jsonl");
    await tick();
    expect(manager.resolveMention("explore")?.kind).toBe("live");

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "Explore", "second", { description: "second", isBackground: true });

    expect(manager.getRecord(id)!.handle).toBe("explore-2");
    // ...and `@explore` still means the conversation you can resume.
    expect(manager.resolveMention("explore")?.kind).toBe("live");
  });

  it("frees the name once the record is reaped, without losing the conversation", async () => {
    // The conversation is a file, not a record: once the 24h window is over the
    // name goes back to the type and a resume by id reopens the file.
    manager = new AgentManager();
    await aged("Explore", "first", RECORD_RETAIN_MS / 60_000 + 0.5, "/sessions/first.jsonl");

    await tick();

    expect(manager.resolveMention("explore")).toBeUndefined();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "Explore", "second", { description: "second", isBackground: true });
    expect(manager.getRecord(id)!.handle).toBe("explore");
  });

  it("keeps a record alive while the process is only part-way through the window", async () => {
    manager = new AgentManager();
    const { id } = await aged("Explore", "half-way", RECORD_RETAIN_MS / 60_000 - 1, "/sessions/half.jsonl");

    await tick();

    expect(manager.getRecord(id)).toBeDefined();
    expect(manager.resolveMention("explore")?.kind).toBe("live");
  });

  it("prefers a live agent over a finished record holding the same name", async () => {
    manager = new AgentManager();
    await aged("Explore", "old", TEN_MINUTES / 60_000 + 0.5, "/sessions/old.jsonl");
    await tick();
    // Give the live agent the finished record's name directly: the collision this
    // guards against is resolution order, not allocation.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "Explore", "live", { description: "live", isBackground: true });
    manager.getRecord(id)!.handle = "explore";

    const resolved = manager.resolveMention("explore");
    expect(resolved?.kind).toBe("live");
    expect(resolved).toMatchObject({ record: { id } });
  });

  it("reaps a later stale record on the next sweep, not just the first", async () => {
    // The timer fires every minute; each pass must be able to reap whatever has
    // aged past the window since the last one.
    manager = new AgentManager();
    const stale = await aged("Explore", "stale-1", RECORD_RETAIN_MS / 60_000 + 0.5);
    await tick();
    expect(manager.getRecord(stale.id)).toBeUndefined();

    const stale2 = await aged("Explore", "stale-2", RECORD_RETAIN_MS / 60_000 + 0.5);
    await tick();
    expect(manager.getRecord(stale2.id)).toBeUndefined();
  });

  it("never reaps a record before its retention window, however it is addressed", async () => {
    // A 24h-old-looking record that is still inside the window is untouched, and
    // the id-prefix resolution that a short id from a notification uses still
    // answers.
    manager = new AgentManager();
    const { id } = await aged("Explore", "resolvable", RECORD_RETAIN_MS / 60_000 - 1, "/sessions/x.jsonl");

    await tick();

    expect(manager.resolveRecord(id.slice(0, 8))?.id).toBe(id);
    expect(manager.resolveMention(id.slice(0, 8))?.kind).toBe("live");
  });
});
