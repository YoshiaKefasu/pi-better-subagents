// Concurrency for the ONE pool that is left: `maxConcurrent` bounds detached
// top-level spawns. The second pool (`maxConcurrentForeground`, which bounded
// agents a caller was blocking on inline) went with the foreground path — this
// file kept its name and was rewritten for what replaced it, because the
// invariants it guarded are the ones that still exist:
//
//   - an inline spawn (`spawnAndWait`) NEVER queues: nested children, workflow
//     children and the agent-file generator must start even when the session's
//     pool is saturated, or a parent blocked awaiting its own child deadlocks;
//   - detached spawns queue FIFO past the limit and drain as slots free;
//   - the slot is released exactly once, by whoever took it, even when the
//     limit is edited mid-run;
//   - every way OUT of the queue (abort, abortAll, dispose) resolves the waiter.
//
// The hangs are the dangerous failures here, not the assertion failures: a
// queued record has no promise to await, and pi has no tool-execution timeout
// anywhere, so anything that waits on one must be released on every path.

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
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { runAgent } from "../src/agent-runner.js";
import { createWorktree } from "../src/worktree.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({ dispose: vi.fn() }) as any;

/** Runs that settle only when their returned resolver is called, keyed by prompt. */
function controllableRuns() {
  const resolvers = new Map<string, () => void>();
  // History, not just the implementation: these tests assert on call COUNTS,
  // and vitest shares the module mock across the file.
  vi.mocked(runAgent).mockClear();
  vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
    new Promise<any>(resolve => {
      resolvers.set(prompt as string, () => resolve({
        responseText: `${prompt}-result`,
        session: mockSession(),
        aborted: false,
        steered: false,
      }));
    }),
  );
  return resolvers;
}

/** Let queued microtasks (gate resolution, settle handlers) run. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** An inline spawn: the caller is blocked awaiting this record. */
const inline = (manager: AgentManager, prompt: string, options: any = {}) =>
  manager.spawnAndWait(mockPi, mockCtx, "general-purpose", prompt, {
    description: prompt,
    ...options,
  });

/** A detached top-level spawn: the one kind that takes a `maxConcurrent` slot. */
const bg = (manager: AgentManager, prompt: string, options: any = {}) =>
  manager.spawn(mockPi, mockCtx, "general-purpose", prompt, {
    description: prompt,
    isBackground: true,
    ...options,
  });

/** The record a spawn created, before it has necessarily started. */
const recordFor = (manager: AgentManager, prompt: string) =>
  manager.listAgents().find(a => a.description === prompt)!;

describe("maxConcurrent (the only pool)", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.mocked(runAgent).mockClear();
  });

  afterEach(() => {
    manager?.dispose();
    vi.mocked(createWorktree).mockReset();
  });

  // The governing constraint: a user who never sets this must see exactly the
  // behaviour that shipped before it existed.
  it("is 10 by default, and the default path starts synchronously", () => {
    controllableRuns();
    manager = new AgentManager();

    expect(manager.getMaxConcurrent()).toBe(10);

    void bg(manager, "a");
    void bg(manager, "b");
    void bg(manager, "c");

    // Synchronously — not after a flush. An await or a yield in the start path
    // would defer at least one of these.
    expect(runAgent).toHaveBeenCalledTimes(3);
    for (const p of ["a", "b", "c"]) expect(recordFor(manager, p).status).toBe("running");
  });

  it("queues detached spawns past the limit and starts them as slots free, in order", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager(undefined, 1); // maxConcurrent = 1

    bg(manager, "a");
    bg(manager, "b");
    bg(manager, "c");

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(recordFor(manager, "b").status).toBe("queued");
    expect(recordFor(manager, "c").status).toBe("queued");

    resolvers.get("a")!();
    await flush();

    // FIFO: "b" was queued first, so "b" runs — not "c".
    expect(recordFor(manager, "b").status).toBe("running");
    expect(recordFor(manager, "c").status).toBe("queued");
    expect(runAgent).toHaveBeenCalledTimes(2);

    resolvers.get("b")!();
    await flush();
    expect(recordFor(manager, "c").status).toBe("running");

    resolvers.get("c")!();
    await flush();
    expect(recordFor(manager, "a").status).toBe("completed");
    expect(recordFor(manager, "b").status).toBe("completed");
    expect(recordFor(manager, "c").status).toBe("completed");
  });

  // The deadlock guard, and the whole reason `spawnAndWait` takes no slot: a
  // nested child's parent is blocked AWAITING it, so queueing the child behind
  // its own parent can never make progress. An inline spawn is not a detached
  // top-level one (`occupiesPoolSlot`), so the queue never sees it.
  it("never queues an inline spawn, however full the pool is", async () => {
    controllableRuns();
    manager = new AgentManager(undefined, 1);

    bg(manager, "bg-holder");
    expect(recordFor(manager, "bg-holder").status).toBe("running");

    void inline(manager, "parent");
    expect(recordFor(manager, "parent").status).toBe("running");

    // A nested child of that inline spawn, with the pool still saturated.
    void inline(manager, "child", { parentAgentId: recordFor(manager, "parent").id, depth: 2 });
    expect(recordFor(manager, "child").status).toBe("running");
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  // A workflow's children go out through `spawnAndWait`, so they are as exempt
  // as nested ones: the run already caps how many of its agents are in flight,
  // and charging them here as well would serialize every workflow on the
  // machine behind a limit meant for the session's own work.
  it("never queues a workflow's children, which the run already bounds", async () => {
    controllableRuns();
    manager = new AgentManager(undefined, 1);

    void inline(manager, "wf-a", { workflowId: "wf1" });
    void inline(manager, "wf-b", { workflowId: "wf1" });
    void inline(manager, "wf-c", { workflowId: "wf1" });

    expect(recordFor(manager, "wf-a").status).toBe("running");
    expect(recordFor(manager, "wf-b").status).toBe("running");
    expect(recordFor(manager, "wf-c").status).toBe("running");
    expect(runAgent).toHaveBeenCalledTimes(3);

    // The session's own detached work is still bounded — the exemption is for
    // the workflow's children, not a hole in the limit.
    bg(manager, "mine-1");
    bg(manager, "mine-2");
    expect(recordFor(manager, "mine-1").status).toBe("running");
    expect(recordFor(manager, "mine-2").status).toBe("queued");
  });

  it("starts a bypassQueue spawn at the limit, and still counts its slot", async () => {
    controllableRuns();
    manager = new AgentManager(undefined, 1);

    bg(manager, "holder");
    bg(manager, "scheduled", { bypassQueue: true });
    expect(recordFor(manager, "scheduled").status).toBe("running");

    // Counted, not invisible: the pool is now over its limit, so the next
    // ordinary detached spawn queues.
    bg(manager, "next");
    expect(recordFor(manager, "next").status).toBe("queued");
  });

  describe("cancellation", () => {
    // A rejection here would escape into the caller's tool `execute` and reject
    // pi's Promise.all for the entire tool batch, killing unrelated tool calls.
    it("resolves — never rejects — when a queued agent is aborted", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager(undefined, 1);

      bg(manager, "holder");
      bg(manager, "victim");
      expect(recordFor(manager, "victim").status).toBe("queued");

      expect(manager.abort(recordFor(manager, "victim").id)).toBe(true);

      resolvers.get("holder")!();
      await flush();
      expect(recordFor(manager, "victim").status).toBe("stopped");
      // Freeing the slot must not resurrect it.
      expect(runAgent).toHaveBeenCalledTimes(1);
    });

    it("releases a queued agent when the caller's signal aborts (Esc)", async () => {
      controllableRuns();
      manager = new AgentManager(undefined, 1);

      bg(manager, "holder");
      const controller = new AbortController();
      bg(manager, "victim", { signal: controller.signal });
      expect(recordFor(manager, "victim").status).toBe("queued");

      controller.abort();
      await flush();
      expect(recordFor(manager, "victim").status).toBe("stopped");
    });

    // addEventListener never fires on an already-aborted signal, so enqueueing
    // here would wait forever — pi has no tool-execution timeout to bail out.
    it("never enqueues a spawn whose signal is already aborted", async () => {
      controllableRuns();
      manager = new AgentManager(undefined, 1);

      bg(manager, "holder");
      const controller = new AbortController();
      controller.abort();

      bg(manager, "victim", { signal: controller.signal });

      expect(recordFor(manager, "victim").status).toBe("stopped");
      expect(manager.listAgents().some(a => a.status === "queued")).toBe(false);
      expect(runAgent).toHaveBeenCalledTimes(1);
    });

    // The one behaviour change that is NOT gated on any setting. Before the
    // queue existed, an already-aborted signal was still wired with
    // addEventListener — which never fires — so the agent ran to completion
    // beyond the reach of Esc or /agents.
    it("stops an immediate spawn whose signal is already aborted", async () => {
      controllableRuns();
      manager = new AgentManager();

      const controller = new AbortController();
      controller.abort();
      void inline(manager, "doomed", { signal: controller.signal });

      expect(recordFor(manager, "doomed").status).toBe("stopped");
      expect(recordFor(manager, "doomed").abortController?.signal.aborted).toBe(true);
    });

    it("releases queued waiters on abortAll()", async () => {
      controllableRuns();
      manager = new AgentManager(undefined, 1);

      bg(manager, "holder");
      bg(manager, "victim");

      manager.abortAll();
      await flush();
      expect(recordFor(manager, "victim").status).toBe("stopped");
      expect(recordFor(manager, "holder").status).toBe("stopped");
    });

    // Without this, `afterEach(() => manager.dispose())` turns any failing test
    // in this file into a hung suite instead of a red one.
    it("clears the queue on dispose()", async () => {
      controllableRuns();
      manager = new AgentManager(undefined, 1);

      bg(manager, "holder");
      bg(manager, "victim");

      await manager.dispose();
      await flush();
      // Nothing queued survives, and nothing queued is ever started afterwards.
      expect(manager.listAgents().some(a => a.status === "queued")).toBe(false);
      expect(runAgent).toHaveBeenCalledTimes(1);
    });
  });

  describe("slot accounting", () => {
    it("frees the slot when a detached agent fails", async () => {
      const rejectors = new Map<string, (e: unknown) => void>();
      vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any) =>
        new Promise<any>((_resolve, reject) => { rejectors.set(prompt as string, reject); }),
      );
      manager = new AgentManager(undefined, 1);

      bg(manager, "a");
      bg(manager, "b");
      expect(recordFor(manager, "b").status).toBe("queued");

      rejectors.get("a")!(new Error("boom"));
      await flush();
      expect(recordFor(manager, "a").status).toBe("error");
      expect(recordFor(manager, "b").status).toBe("running");
    });

    // Decrementing in abort() as well as in the settle path is a double-free
    // that permanently lifts the limit. Three at a limit of one catches it: a
    // double-free would start the third immediately.
    it("frees the slot exactly once when a running agent is aborted", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager(undefined, 1);

      bg(manager, "a");
      bg(manager, "b");
      bg(manager, "c");

      manager.abort(recordFor(manager, "a").id);
      resolvers.get("a")!(); // the aborted run still settles normally
      await flush();

      expect(recordFor(manager, "b").status).toBe("running");
      expect(recordFor(manager, "c").status).toBe("queued");
    });
  });

  // #179: a strict worktree-isolation failure throws out of spawnAndWait on the
  // immediate path. Queue pressure must not silently turn either failure into a
  // result — for a detached spawn the failure lands on the record.
  it("parks a drain-time startup failure on the record, and keeps draining", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager(undefined, 1);

    vi.mocked(createWorktree).mockReturnValue(undefined as any);

    bg(manager, "holder");
    bg(manager, "doomed", { isolation: "worktree" });
    bg(manager, "after");
    expect(recordFor(manager, "doomed").status).toBe("queued");

    resolvers.get("holder")!();
    await flush();

    expect(recordFor(manager, "doomed").status).toBe("error");
    expect(recordFor(manager, "doomed").error).toMatch(/worktree/i);

    // The failure freed nothing, but it also blocked nothing.
    expect(recordFor(manager, "after").status).toBe("running");
    resolvers.get("after")!();
    await flush();
  });

  it("drains immediately when the limit is raised", async () => {
    controllableRuns();
    manager = new AgentManager(undefined, 1);

    bg(manager, "a");
    bg(manager, "b");
    bg(manager, "c");
    expect(runAgent).toHaveBeenCalledTimes(1);

    manager.setMaxConcurrent(3);
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  // The acquire/release pair must agree even though the limit between them is
  // user-editable at runtime (`/agents → Settings`, and applySettings on load).
  // Recomputing the pool at settle time made the release disagree with the
  // acquire in both directions.
  describe("a limit changed mid-run", () => {
    it("releases the slot a cleared limit no longer describes", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager(undefined, 1);

      bg(manager, "a");
      manager.setMaxConcurrent(10); // raised while "a" holds a slot
      resolvers.get("a")!();
      await flush();

      // The slot must have come back. If it leaked, nothing can ever free it
      // again and every later detached spawn queues forever.
      manager.setMaxConcurrent(1);
      bg(manager, "b");
      await flush();
      expect(recordFor(manager, "b").status).toBe("running");
    });

    it("does not release a slot a newly-set limit was never charged", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager(undefined, 10);

      bg(manager, "a"); // within the default limit — takes a slot
      manager.setMaxConcurrent(1);
      resolvers.get("a")!();
      await flush();

      // The counter must still be 0, not -1: a -1 silently lifts the limit by one.
      bg(manager, "b");
      bg(manager, "c");
      await flush();
      expect(recordFor(manager, "b").status).toBe("running");
      expect(recordFor(manager, "c").status).toBe("queued");
    });
  });

  it("clamps a limit below 1 up to 1 rather than to unlimited", () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrent(-3);
    expect(manager.getMaxConcurrent()).toBe(1);
  });

  it("counts a queued agent as active, and waitForAll waits it out", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager(undefined, 1);

    bg(manager, "a");
    bg(manager, "b");
    expect(manager.hasRunning()).toBe(true);

    const all = manager.waitForAll();
    resolvers.get("a")!();
    await flush();
    resolvers.get("b")!();
    await all;

    expect(recordFor(manager, "b").status).toBe("completed");
  });

  // spawnAndWait used to park this callback on the manager and restore it in a
  // `finally` right after spawn() — which only worked because spawn() reached
  // startAgent() synchronously. It rides on the options instead, so a spawn
  // that starts at drain time still reaches the caller that queued it.
  it("fires each caller's onSpawned hook when its own deferred spawn starts", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager(undefined, 1);

    const firstHook = vi.fn();
    const secondHook = vi.fn();

    bg(manager, "a", { onSpawned: firstHook });
    bg(manager, "b", { onSpawned: secondHook });

    expect(firstHook).toHaveBeenCalledTimes(1);
    expect(secondHook).not.toHaveBeenCalled();

    resolvers.get("a")!();
    await flush();

    expect(secondHook).toHaveBeenCalledTimes(1);
    expect(secondHook).toHaveBeenCalledWith(recordFor(manager, "b").id);
    expect(firstHook).toHaveBeenCalledTimes(1);

    resolvers.get("b")!();
    await flush();
  });
});
