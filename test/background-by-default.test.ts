/**
 * background-only.test.ts — background execution asserted at the tool boundary
 * rather than at the resolver.
 *
 * Every top-level spawn is detached: there is no foreground path left, so this
 * pins what the orchestrator actually receives back from a real `Agent` call,
 * which is the part the tool description makes promises about:
 *
 *   - a spawn hands back an ID instead of the agent's output,
 *   - a stale `run_in_background: false` from an old habit is ignored rather
 *     than erroring, and still hands back an ID,
 *   - a fan-out sized like the ones the description tells the model to send
 *     runs concurrently instead of queueing behind `maxConcurrent` — the
 *     reason the concurrency default moved 4 → 10.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

const settled = (text: string) =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: text,
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  } as any);

function spawn(tools: Map<string, any>, params: Record<string, unknown> = {}) {
  return tools.get("Agent").execute(
    "tc",
    { prompt: "go", description: "d", subagent_type: "general-purpose", ...params },
    undefined,
    undefined,
    ctx(),
  );
}

describe("background execution (no foreground path)", () => {
  it("returns an agent ID, not the result, when the call doesn't specify", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    settled("THE-PAYLOAD");

    const out = textOf(await spawn(tools));

    expect(out).toContain("Agent ID:");
    // The whole point of backgrounding: the orchestrator does NOT get the
    // output here — it arrives later as a notification preview.
    expect(out).not.toContain("THE-PAYLOAD");
  });

  // The parameter is gone from the schema, but a cached transcript or a model
  // repeating an old habit can still send it. It must be inert — never an
  // "unknown parameter" error, and never a second spawn path to fall into.
  it("ignores a stale run_in_background: false instead of blocking or erroring", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    settled("THE-PAYLOAD");

    const out = textOf(await spawn(tools, { run_in_background: false }));

    expect(out).toContain("Agent ID:");
    expect(out).toContain("started in background");
    expect(out).not.toContain("THE-PAYLOAD");
  });

  it("starts a six-way fan-out concurrently instead of queueing the tail", async () => {
    // Six is the shape the Agent tool description tells the model to send.
    // With maxConcurrent at its old 4 this queued two of them.
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    // Never settles — every agent stays occupying its slot for the whole test.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const outs: string[] = [];
    for (let i = 0; i < 6; i++) outs.push(textOf(await spawn(tools)));

    expect(outs).toHaveLength(6);
    for (const out of outs) expect(out).not.toContain("queued");
  });
});
