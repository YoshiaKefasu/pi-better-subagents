/**
 * concurrency-wiring.test.ts — `maxConcurrent`, through the REAL extension, at
 * the layer the setting exists to serve.
 *
 * pi's agent loop runs a message's tool calls through `Promise.all`, so two
 * `Agent` calls in one message start within microseconds of each other. These
 * tests dispatch them the same way — two `execute()` calls without awaiting the
 * first — because that is the only shape in which the queue is reachable, and
 * it is the shape that constrains everything else here:
 *
 *   a tool `execute` that REJECTS rejects that whole Promise.all, killing
 *   unrelated tool calls in the same batch.
 *
 * Every spawn is detached now, so a queued call hands back its id immediately
 * and its result arrives through get_subagent_result. The Promise.all hazard
 * moved with the foreground path; what is left is that a queued call still
 * RESOLVES, and that the queue never eats a result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  // The manager registry is a globalThis symbol released only on shutdown; a
  // test that threw first would leave the next one reading a dead manager.
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

/** Boot the real extension with background concurrency pinned to one slot. */
function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({
    settings: { outputTranscript: false, maxConcurrent: 1, ...settings },
  });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

/** Runs that settle only when their resolver is called, keyed by prompt. */
function controllableRuns() {
  const resolvers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation(
    (_c: any, _t: any, prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        opts.onSessionCreated?.({
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
          messages: [],
          getActiveToolNames: vi.fn(() => []),
        });
        resolvers.set(prompt as string, () => resolve({
          responseText: `${prompt}-RESULT`,
          session: { dispose: vi.fn() },
          aborted: false,
          steered: false,
        }));
      }) as any,
  );
  return resolvers;
}

/** Dispatch an Agent call the way pi does — without awaiting it. */
function call(tools: Map<string, any>, prompt: string, opts: { signal?: AbortSignal } = {}) {
  return tools.get("Agent").execute(
    `tc-${prompt}`,
    { prompt, description: prompt, subagent_type: "general-purpose" },
    opts.signal,
    undefined,
    ctx(),
  );
}

/** The id a spawn receipt handed back. */
const idOf = (r: any): string => /Agent ID: (\S+)/.exec(textOf(r))![1];

describe("maxConcurrent, through the Agent tool", () => {
  it("runs detached calls one at a time and delivers each its own result", async () => {
    const { tools } = boot();
    const resolvers = controllableRuns();

    const first = await call(tools, "alpha");
    const second = await call(tools, "beta");
    await flush();

    // Only one started; "beta" is parked on the pool, and its call already
    // returned an id rather than blocking the batch.
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(textOf(second)).toContain("queued");

    resolvers.get("alpha")!();
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(2);

    resolvers.get("beta")!();
    await flush();

    const alphaText = textOf(await tools.get("get_subagent_result").execute(
      "get-alpha", { agent_id: idOf(first), wait: true }, undefined, undefined, ctx(),
    ));
    const betaText = textOf(await tools.get("get_subagent_result").execute(
      "get-beta", { agent_id: idOf(second), wait: true }, undefined, undefined, ctx(),
    ));
    expect(alphaText).toContain("alpha-RESULT");
    expect(betaText).toContain("beta-RESULT");
  });

  // Every call resolves — including one that queues behind the limit — so the
  // Promise.all batch is never rejected by queue pressure. (Esc cannot reach a
  // queued spawn through the tool: a detached spawn deliberately carries no
  // parent signal, which is what keeps it alive past the turn that started it.
  // That path is covered at the manager level in foreground-concurrency.test.ts.)
  it("resolves a queued call instead of rejecting the batch", async () => {
    const { tools } = boot();
    const resolvers = controllableRuns();

    const first = await call(tools, "alpha");
    const second = await call(tools, "beta");
    await flush();

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(textOf(second)).toContain("queued");
    // Both calls came back with a receipt rather than blocking or throwing.
    expect(textOf(first)).toContain("started");

    // Free the slot so the queued one starts, then settle it too — otherwise
    // the manager still holds a running agent when the suite tears down.
    resolvers.get("alpha")!();
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(2);
    resolvers.get("beta")!();
    await flush();
  });

  // An agent that has not started yet is not "thinking…" — the receipt has to
  // say it is waiting for a slot, and stop saying so once the pool is idle.
  // The step-by-step chain is deliberate: at a limit of one, every freed slot
  // is taken by the agent queued behind it, so only the call AFTER the last
  // queued agent has started can read "started".
  it("says it is queued in the receipt, and started once the pool is idle", async () => {
    const { tools } = boot();
    const resolvers = controllableRuns();

    const alpha = await call(tools, "alpha");
    const beta = await call(tools, "beta");
    expect(textOf(alpha)).toContain("started");
    expect(textOf(beta)).toContain("queued (max 1 concurrent)");

    // alpha frees the slot → beta starts → gamma queues.
    resolvers.get("alpha")!();
    await flush();
    expect(textOf(await call(tools, "gamma"))).toContain("queued");

    // beta frees the slot → gamma starts → delta queues.
    resolvers.get("beta")!();
    await flush();
    expect(textOf(await call(tools, "delta"))).toContain("queued");

    // gamma frees the slot → delta starts → epsilon queues.
    resolvers.get("gamma")!();
    await flush();
    expect(textOf(await call(tools, "epsilon"))).toContain("queued");

    // delta frees the slot → epsilon starts.
    resolvers.get("delta")!();
    await flush();
    // epsilon frees the last slot → the pool is idle, so the next receipt reads
    // "started" with no queue position at all.
    resolvers.get("epsilon")!();
    await flush();
    const zeta = await call(tools, "zeta");
    expect(textOf(zeta)).toContain("started in background");
    expect(textOf(zeta)).not.toContain("queued");

    resolvers.get("zeta")!();
    await flush();
  });

  it("leaves calls unbounded when the pool is roomy", async () => {
    const { tools } = boot({ maxConcurrent: 10 });
    const resolvers = controllableRuns();

    const calls = await Promise.all(["a", "b", "c"].map(p => call(tools, p)));
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(3);
    for (const c of calls) expect(textOf(c)).toContain("started");
    for (const p of ["a", "b", "c"]) resolvers.get(p)!();
    await Promise.all(calls);
  });
});
