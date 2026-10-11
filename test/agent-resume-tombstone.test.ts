/**
 * agent-resume-tombstone.test.ts — the `Agent` tool's `resume` reaching a
 * GC-evicted agent through its tombstone.
 *
 * Resolution order in the resume branch: memory (`resolveRecord`) → pi session
 * on disk (`findSessionOnDisk`) → tombstone (`resolveMention`). The third leg
 * is what this file pins: after the 10-minute cleanup drops the record, a
 * resume by handle/alias/id must reopen the session file as a fresh record
 * (reclaim＋resumeSessionFile, same as the `@handle` mention path) instead of
 * answering `Agent not found`.
 *
 * Booted through the real extension so the assertions cover the actual wiring.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
/** The most recently booted extension, so teardown runs even when a test throws. */
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

/** Enough of an AgentSession for the manager's and index's hooks. */
function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    ...overrides,
  } as any;
}

/** A runAgent that finishes immediately, leaving a resumable record behind. */
function finishedRun(session: any, text = "first answer") {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: text,
    session,
    aborted: false,
    steered: false,
    failure: undefined,
  } as any);
}

/** Boot the real extension. `outputTranscript: false` keeps the run off disk. */
function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

async function spawnBackground(
  tools: Map<string, any>,
  subagent_type = "Explore",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "find flaky tests", subagent_type, run_in_background: true, ...extra },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const managerOf = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];

describe("Agent tool resume from a tombstone", () => {
  // Only the GC interval and Date are faked: `flush()` runs on setImmediate,
  // and the manager's cleanup timer is started in its constructor, so the
  // fake clock has to be installed before boot().
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "Date"] }));
  afterEach(() => vi.useRealTimers());

  /**
   * Age the record past the cutoff and let the real GC evict it. The session
   * file has to exist on disk: the resume path refuses to reopen one it cannot
   * find, so a fictional path would take the `Agent not found` branch and
   * every resume assertion below would pass for the wrong reason.
   */
  async function evict(id: string, withFile = true) {
    const manager = managerOf();
    const record = manager.getRecord(id);
    record.sessionFile = join(process.cwd(), "explore-session.jsonl");
    if (withFile) writeFileSync(record.sessionFile, "");
    const handle = record.handle;
    const alias = record.alias;
    record.completedAt = Date.now() - 11 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    return { manager, handle, alias };
  }

  it("reopens the conversation by handle after GC instead of `Agent not found`", async () => {
    const { tools } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    const { manager, handle } = await evict(id);
    expect(manager.getRecord(id)).toBeUndefined();
    // resolveAgentRef は live のみを見る: evict 後に何も残っていない = メモリ miss。
    expect(manager.resolveAgentRef(handle)).toBeUndefined();
    vi.mocked(runAgent).mockClear();
    finishedRun(fakeSession(), "resumed answer");

    const result = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "follow-up", description: "Follow-up", subagent_type: "Explore", resume: handle },
      undefined,
      undefined,
      ctx(),
    );
    await flush();

    // Reopen is detached like every other spawn: the answer arrives in the
    // completion notification, and this call hands back an id.
    expect(textOf(result)).toContain("resumed from disk in background");
    expect(textOf(result)).toContain("Agent ID:");
    expect(textOf(result)).not.toContain("Agent not found");
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][1]).toBe("Explore");
    expect(vi.mocked(runAgent).mock.calls[0][2]).toBe("follow-up");
    const resumeOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(resumeOpts.resumeSessionFile).toBe(join(process.cwd(), "explore-session.jsonl"));
    // reclaim が効いている: 新規レコードが handle をそのまま取り戻す。
    const resumedId = (vi.mocked(runAgent).mock.calls[0][3] as any).agentId;
    expect(manager.getRecord(resumedId).handle).toBe(handle);
  });

  it("reopens by alias and hands the name back instead of numbering it", async () => {
    const { tools } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools, "Explore", { name: "auth-audit" });
    await flush();
    const { manager, alias } = await evict(id);
    expect(alias).toBeTruthy();
    expect(manager.resolveAgentRef(alias)).toBeUndefined();
    vi.mocked(runAgent).mockClear();
    finishedRun(fakeSession(), "resumed answer");

    const result = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "follow-up", description: "Follow-up", subagent_type: "Explore", resume: alias },
      undefined,
      undefined,
      ctx(),
    );
    await flush();

    expect(textOf(result)).toContain("resumed from disk in background");
    const resumedId = (vi.mocked(runAgent).mock.calls[0][3] as any).agentId;
    expect(manager.getRecord(resumedId).alias).toBe(alias);
  });

  it("keeps the `Agent not found` message when the session file is gone", async () => {
    const { tools } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    const { handle } = await evict(id, false);
    vi.mocked(runAgent).mockClear();

    const result = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "follow-up", description: "Follow-up", subagent_type: "Explore", resume: handle },
      undefined,
      undefined,
      ctx(),
    );
    await flush();

    expect(textOf(result)).toBe(`Agent not found: "${handle}". It may have been cleaned up.`);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it("resumes from a tombstone in background without blocking", async () => {
    const { tools } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    const { manager, handle } = await evict(id);
    expect(manager.getRecord(id)).toBeUndefined();
    vi.mocked(runAgent).mockClear();
    finishedRun(fakeSession(), "resumed answer");

    const result = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "follow-up", description: "Follow-up", subagent_type: "Explore", resume: handle, run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).toContain("resumed");
    expect(textOf(result)).toContain("Agent ID:");
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    const bgOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(bgOpts.resumeSessionFile).toBe(join(process.cwd(), "explore-session.jsonl"));
    // reclaim が効いている: 新規レコードが handle をそのまま取り戻す。
    expect(manager.getRecord(bgOpts.agentId).handle).toBe(handle);
  });
});
