/**
 * agent-resume-tombstone.test.ts — the `Agent` tool's `resume` reaching a
 * finished agent through what it left on disk.
 *
 * The file name is kept for history; the tombstone store it used to pin is
 * gone. What it pins now is the replacement: a finished agent's record lives
 * 24 hours in memory (its live session released after 10 minutes), and the
 * conversation itself lives on disk — the pi session file, its `archive/`
 * sibling after 24h idle, and a pi session rebuilt from the `.output`
 * transcript. A resume picks whichever of those still exists.
 *
 * Resolution order in the resume branch: memory (`resolveRecord`) → disk
 * (`findSessionOnDisk`). The second leg is what this file pins: once the
 * record's session was released — or the record itself reaped — a resume by
 * handle, alias or id prefix still reopens the conversation instead of
 * answering `Agent not found`.
 *
 * Booted through the real extension so the assertions cover the actual wiring.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Boot the real extension. `outputTranscript` is left at its default (`true`)
 * unless a test asks otherwise — it is what leaves the `.output` transcript the
 * last-resort leg reopens from.
 */
function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings });
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

describe("Agent tool resume from disk", () => {
  // Only the GC interval and Date are faked: `flush()` runs on setImmediate,
  // and the manager's cleanup timer is started in its constructor, so the
  // fake clock has to be installed before boot().
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "Date"] }));
  afterEach(() => vi.useRealTimers());

  /**
   * Age a finished record and let the real GC run.
   *
   * `minutes >= 10` releases the live session (the record stays, so it is still
   * a memory hit); `minutes >= 24h` reaps the record itself. The session file
   * has to exist on disk when `sessionFile` is given: the resume path refuses
   * to reopen one it cannot find, so a fictional path would take the
   * `Agent not found` branch and every assertion below would pass for the
   * wrong reason.
   */
  async function age(id: string, minutes: number, sessionFile?: string) {
    const manager = managerOf();
    const record = manager.getRecord(id);
    if (sessionFile !== undefined) {
      record.sessionFile = sessionFile;
      writeFileSync(sessionFile, "");
    }
    record.completedAt = Date.now() - minutes * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    return { manager, record, handle: record.handle, alias: record.alias };
  }

  const resumeBy = (tools: Map<string, any>, resume: string, extra: Record<string, unknown> = {}) =>
    tools.get("Agent").execute(
      "tc-resume",
      { prompt: "follow-up", description: "Follow-up", subagent_type: "Explore", resume, ...extra },
      undefined,
      undefined,
      ctx(),
    );

  it("reopens the conversation by handle once its live session was released", async () => {
    const { tools } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    const sessionFile = join(process.cwd(), "explore-session.jsonl");
    const { manager, handle, record } = await age(id, 11, sessionFile);
    expect(manager.getRecord(id)).toBeDefined();
    // The sweep's first stage: the live session object is gone, the record stays.
    expect(record.session).toBeUndefined();
    expect(manager.resolveAgentRef(handle)).toBeDefined();
    vi.mocked(runAgent).mockClear();
    finishedRun(fakeSession(), "resumed answer");

    const result = await resumeBy(tools, handle);
    await flush();

    expect(textOf(result)).toContain("resumed from disk in background");
    expect(textOf(result)).toContain("Agent ID:");
    expect(textOf(result)).not.toContain("Agent not found");
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgent).mock.calls[0][1]).toBe("Explore");
    expect(vi.mocked(runAgent).mock.calls[0][2]).toBe("follow-up");
    const resumeOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(resumeOpts.resumeSessionFile).toBe(sessionFile);
    // reclaim が効いている: 新規レコードが handle をそのまま取り戻す。
    expect(manager.getRecord(resumeOpts.agentId).handle).toBe(handle);
  });

  it("reopens by alias and hands the name back instead of numbering it", async () => {
    const { tools } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools, "Explore", { name: "auth-audit" });
    await flush();
    const sessionFile = join(process.cwd(), "alias-session.jsonl");
    const { manager, alias } = await age(id, 11, sessionFile);
    expect(alias).toBeTruthy();
    vi.mocked(runAgent).mockClear();
    finishedRun(fakeSession(), "resumed answer");

    const result = await resumeBy(tools, alias);
    await flush();

    expect(textOf(result)).toContain("resumed from disk in background");
    const resumedId = (vi.mocked(runAgent).mock.calls[0][3] as any).agentId;
    expect(manager.getRecord(resumedId).alias).toBe(alias);
  });

  it("reopens from the .output transcript when the session was never persisted", async () => {
    // `rememberAgents: false` (or an in-memory session) leaves no session file
    // at all — the transcript is the whole conversation, and a pi session is
    // rebuilt from it.
    const { tools } = boot({ rememberAgents: false });
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    const { manager, handle, record } = await age(id, 11);
    expect(record.sessionFile).toBeUndefined();
    expect(record.outputFile).toBeTruthy();
    const transcript = record.outputFile!;
    // The run's prompt reached the transcript, so there is something to rebuild.
    expect(readFileSync(transcript, "utf-8")).toContain("go");
    vi.mocked(runAgent).mockClear();
    finishedRun(fakeSession(), "resumed answer");

    const result = await resumeBy(tools, handle);
    await flush();

    expect(textOf(result)).toContain("resumed from disk in background");
    const resumeOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    // Not the transcript itself: a pi session rebuilt from it.
    expect(resumeOpts.resumeSessionFile).not.toBe(transcript);
    expect(existsSync(resumeOpts.resumeSessionFile)).toBe(true);
    expect(resumeOpts.resumeSessionFile.endsWith(`recovered-${id}.jsonl`)).toBe(true);
    expect(manager.getRecord(resumeOpts.agentId).handle).toBe(handle);
  });

  it("reopens by a unique id prefix from the transcript once the record is gone", async () => {
    // Past the 24h retention the record itself is reaped, so nothing in memory
    // names the agent any more. The transcript is still there, and a short id
    // from a completion notification still finds it.
    const { tools } = boot({ rememberAgents: false });
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    const { manager } = await age(id, 25 * 60);
    expect(manager.getRecord(id)).toBeUndefined();
    vi.mocked(runAgent).mockClear();
    finishedRun(fakeSession(), "resumed answer");

    const result = await resumeBy(tools, id.slice(0, 8));
    await flush();

    expect(textOf(result)).toContain("resumed from disk in background");
    expect(textOf(result)).not.toContain("Agent not found");
    const resumeOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(existsSync(resumeOpts.resumeSessionFile)).toBe(true);
    expect(resumeOpts.resumeSessionFile.endsWith(`recovered-${id}.jsonl`)).toBe(true);
  });

  it("finds the transcript in archive/ after session-archive moved the session", async () => {
    // session-archive moves a stale child transcript into `<sessionDir>/archive/`
    // (on by default since the 24h window). The resume has to follow it there.
    const { tools } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    const sessionDir = (await import("node:fs")).mkdtempSync(join(process.cwd(), "archivedir-"));
    const sessionFile = join(sessionDir, "s1.jsonl");
    const { manager, handle } = await age(id, 11, sessionFile);
    (await import("node:fs")).mkdirSync(join(sessionDir, "archive"), { recursive: true });
    const archivedPath = join(sessionDir, "archive", "s1.jsonl");
    (await import("node:fs")).renameSync(sessionFile, archivedPath);
    expect(existsSync(sessionFile)).toBe(false);

    const sessionCtx = ctx({
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [],
        getSessionDir: () => sessionDir,
      },
    });
    vi.mocked(runAgent).mockClear();
    finishedRun(fakeSession(), "resumed answer");
    const result = await tools.get("Agent").execute(
      "tc-resume",
      { prompt: "follow-up", description: "Follow-up", subagent_type: "Explore", resume: handle },
      undefined,
      undefined,
      sessionCtx,
    );
    await flush();

    expect(textOf(result)).toContain("resumed from disk in background");
    expect(textOf(result)).not.toContain("Agent not found");
    // The archive sibling is the reopen source, and the record keeps its handle.
    const resumeOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(resumeOpts.resumeSessionFile).toBe(archivedPath);
    expect(manager.getRecord(resumeOpts.agentId).handle).toBe(handle);
  });

  it("answers `Agent not found` with neither a session file nor a transcript", async () => {
    // Both persistence features off and both files wiped: nothing to reopen.
    const { tools } = boot({ rememberAgents: false, outputTranscript: false });
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    const { manager, handle, record } = await age(id, 11);
    expect(record.sessionFile).toBeUndefined();
    expect(record.outputFile).toBeUndefined();
    vi.mocked(runAgent).mockClear();

    const result = await resumeBy(tools, handle);
    await flush();

    expect(textOf(result)).toBe(`Agent "${handle}" has no session to resume.`);
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    // The record is still there — nothing was silently discarded.
    expect(manager.getRecord(id)).toBeDefined();
  });

  it("resumes from disk in background without blocking", async () => {
    const { tools } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    const sessionFile = join(process.cwd(), "bg-session.jsonl");
    const { manager, handle } = await age(id, 11, sessionFile);
    vi.mocked(runAgent).mockClear();
    finishedRun(fakeSession(), "resumed answer");

    const result = await resumeBy(tools, handle, { run_in_background: true });

    expect(textOf(result)).toContain("resumed");
    expect(textOf(result)).toContain("Agent ID:");
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    const bgOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(bgOpts.resumeSessionFile).toBe(sessionFile);
    expect(manager.getRecord(bgOpts.agentId).handle).toBe(handle);
  });
});
