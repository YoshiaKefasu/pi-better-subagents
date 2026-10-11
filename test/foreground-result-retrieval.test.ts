/**
 * result-retrieval.test.ts — issue #174, via the REAL Agent tool + the REAL
 * get_subagent_result tool.
 *
 * Report: an agent that wraps up at max_turns returns its partial result, but a
 * get_subagent_result for "that agent ID" immediately afterwards answers
 * `Agent not found ... It may have been cleaned up.` — with no /new, /resume or
 * session switch in between.
 *
 * The premise is gone with the foreground path — the reporter's agent used to
 * return its result inline and its id lived only in renderer `details`, which is
 * never serialized to the API. A detached spawn puts `Agent ID: ...` in the text
 * the model actually receives, so the id it passes back is one we issued. What
 * remains is the other half of the bug, and these tests pin it:
 *
 *   1. The record is NOT cleaned up by completion. A lookup with the REAL id
 *      succeeds, and carries the full payload.
 *   2. An id we never issued is still correctly rejected — the reporter's error,
 *      reproduced WITHOUT any record having been cleaned up.
 *   3. The eviction rule that DOES apply: a session switch keeps an UNREAD
 *      result (that is what `skipUnconsumed` buys) and drops a consumed one.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
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

/**
 * Run an agent that wraps up at the turn limit — the exact #174 shape.
 * `steered: true` is what agent-manager turns into status "steered", which is
 * what produces the reporter's "(wrapped up at the turn limit — output may be
 * partial)" note.
 *
 * Returns the receipt plus the id read out of its TEXT — the only place a
 * detached id exists, which is the point of test 2.
 */
async function runSteeredAgent(tools: Map<string, any>) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-RESULT-PAYLOAD",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: true,
  });
  const res = await tools.get("Agent").execute(
    "tc-spawn",
    {
      prompt: "Perform a very thorough read-only codebase exploration.",
      description: "Locate organization-scope changes",
      subagent_type: "Explore",
      max_turns: 20,
    },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(res))?.[1];
  expect(id, "detached spawn should have put an agent id in its receipt").toBeTruthy();
  return { res, id: id as string };
}

describe("issue #174: agent that hits max_turns", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Hermetic cwd + global dir, scheduling off — same isolation as
    // clear-completed-wiring.test.ts, so session_start doesn't spin a
    // scheduler or touch the dev's filesystem.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-174-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-174-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is NOT cleaned up — get_subagent_result with the real id still resolves it", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { id } = await runSteeredAgent(tools);

    // No /new, no /resume, no session switch — exactly the reporter's sequence.
    const read = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(read);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");
    // ...and it reads as the truncated run it was, not a completion.
    expect(out).toContain("wrapped up at the turn limit");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("hands the model the real id, and still rejects an invented one", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { res, id } = await runSteeredAgent(tools);

    // `content` is the only thing serialized to the API — and there the id is.
    expect(textOf(res)).toContain(id);
    expect(textOf(res)).toMatch(/Agent ID:/);

    // An id we never issued is correctly rejected: this is the reporter's error,
    // reproduced WITHOUT any record having been cleaned up.
    const bogus = await tools.get("get_subagent_result").execute(
      "tc-bogus",
      { agent_id: "3f1320a7-74ec-422" },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(bogus)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("survives a subagent session's OWN activation lifecycle (adversarial: cross-activation eviction)", async () => {
    // The one mechanism that could produce the reported symptom with no
    // user-visible session change: a second activation of this extension in the
    // same process. Child sessions no longer reach it — activation returns early
    // under `inChildSessionContext()` — but any other in-process activation still
    // can, and if its session_start / session_shutdown reached the PARENT's
    // manager, that activation ending would wipe the parent's records.
    const parent = makePi();
    subagentsExtension(parent.pi);
    await parent.lifecycle.get("session_start")?.({}, ctx());
    const { id } = await runSteeredAgent(parent.tools);

    // A child activation runs its full lifecycle, as a subagent session does.
    const child = makePi();
    subagentsExtension(child.pi);
    await child.lifecycle.get("session_start")?.({}, ctx());
    await child.lifecycle.get("session_shutdown")?.({}, ctx());

    // The parent's record must be untouched — separate manager per activation.
    const read = await parent.tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(read);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await parent.lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("is KEPT by a session switch while its result is unread, then evicted once consumed", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { id } = await runSteeredAgent(tools);

    // An unread result is exactly what `skipUnconsumed` preserves: the switch
    // happens before the orchestrator has had a chance to fetch it.
    await lifecycle.get("session_before_switch")?.();
    let read = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(read)).not.toContain("Agent not found");
    expect(textOf(read)).toContain("THE-RESULT-PAYLOAD");

    // Once it HAS been read, the next boundary may drop it — the manager never
    // keeps a consumed record alive for a session that is leaving anyway.
    await lifecycle.get("session_before_switch")?.();
    read = await tools.get("get_subagent_result").execute("tc-read-2", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(read)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
