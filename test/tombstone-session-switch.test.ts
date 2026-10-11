/**
 * session-switch-resume.test.ts (file name kept from `tombstone-session-switch.test.ts`)
 * — resume across the paths that used to destroy it, through the REAL extension
 * wiring.
 *
 * The tombstone store this file used to pin is gone, so it now pins the
 * replacement:
 *
 * 1. `session_start` (and `session_before_switch`, which calls the same
 *    `clearCompleted(true)`) reaps the finished records from memory. The
 *    conversations are not records — they are files, and a resume by id, handle
 *    or alias still reopens one.
 * 2. When pi's session-archive moves a transcript into `archive/`, the fork-side
 *    `scanArchiveSessions` fallback still finds it, and a resume follows it
 *    there. Archiving is ON by default now, so this is the normal path for a
 *    transcript that has been idle a day.
 *
 * Booted through the real extension so the assertions cover the actual wiring,
 * mirroring `test/agent-resume-tombstone.test.ts` (which pins the pre-switch
 * resume legs this builds on).
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension, { scanArchiveSessions } from "../src/index.js";
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
  vi.mocked(runAgent).mockImplementationOnce(async (_ctx: any, _type: any, _prompt: any, options: any) => {
    options.onSessionCreated?.(session);
    return { responseText: text, session, aborted: false, steered: false, failure: undefined };
  });
}

/**
 * Boot the real extension. Settings are left at their defaults — `rememberAgents`
 * and `outputTranscript` are both on, which is what leaves a session file and a
 * transcript for the resume legs below to find.
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
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "find flaky tests", subagent_type: "general-purpose", run_in_background: true, ...extra },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const managerOf = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];

/**
 * Write a session file the way a persisted subagent session looks on disk: a v3
 * header plus the `session_info` name the runner stamps (`type#handle#alias#id8`).
 * That name is the only on-disk link from a `.jsonl` back to an agent, which is
 * what makes a handle/alias resume possible once the record is gone.
 */
function writeSessionFile(path: string, agentId: string, names: (string | undefined)[]): void {
  const now = new Date().toISOString();
  const name = names.filter(Boolean).join("#");
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: agentId, timestamp: now, cwd: process.cwd() }),
    JSON.stringify({ type: "session_info", id: "hdr00001", parentId: null, timestamp: now, name }),
    JSON.stringify({ type: "message", id: "msg00001", parentId: "hdr00001", timestamp: now, message: { role: "user", content: [{ type: "text", text: "go" }] } }),
  ].join("\n") + "\n", "utf-8");
}

/** Age a record past the retention window so the real GC reaps it. */
async function reap(id: string, sessionFile?: string) {
  const manager = managerOf();
  const record = manager.getRecord(id);
  if (sessionFile !== undefined) {
    record.sessionFile = sessionFile;
    writeFileSync(sessionFile, "");
  }
  record.completedAt = Date.now() - 25 * 60 * 60_000;
  await vi.advanceTimersByTimeAsync(60_000);
  // Reaped from live memory: whatever answers the resume below must come from
  // disk, not from a record.
  expect(manager.getRecord(id)).toBeUndefined();
  return { manager, handle: record.handle, alias: record.alias };
}

async function resume(
  tools: Map<string, any>,
  query: string,
  sessionCtx = ctx(),
) {
  finishedRun(fakeSession(), "resumed answer");
  return tools.get("Agent").execute(
    "tc-resume",
    { prompt: "follow-up", description: "Follow-up", subagent_type: "general-purpose", resume: query },
    undefined,
    undefined,
    sessionCtx,
  );
}

describe("resume across session boundaries", () => {
  // Only the GC interval and Date are faked: `flush()` runs on setImmediate,
  // and the manager's cleanup timer is started in its constructor, so the
  // fake clock has to be installed before boot().
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("stays resumable after session_start reaped the record", async () => {
    const { tools, lifecycle } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    await reap(id);

    // The session boundary: records go, files stay.
    await lifecycle.get("session_start")?.({}, ctx());

    vi.mocked(runAgent).mockClear();
    const result = await resume(tools, id.slice(0, 8));
    await flush();

    expect(textOf(result)).toContain("resumed from disk in background");
    expect(textOf(result)).toContain("Agent ID:");
    expect(textOf(result)).not.toContain("Agent not found");
    // Rebuilt from the `.output` transcript, since this run left no session file.
    const resumeOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(resumeOpts.resumeSessionFile.endsWith(`recovered-${id}.jsonl`)).toBe(true);
    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("finds the transcript in archive/ after session-archive moved it", async () => {
    const { tools, lifecycle } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools, { name: "auth-audit" });
    await flush();
    // sessionDir は pi が握る実ディレクトリ、archive/ はその配下という実配置。
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-switch-sessiondir-"));
    const livePath = join(sessionDir, "sub.jsonl");
    writeSessionFile(livePath, id, ["general-purpose", "general-purpose", "auth-audit", id.slice(0, 8)]);
    const { alias } = await reap(id);
    expect(alias).toBe("auth-audit");
    mkdirSync(join(sessionDir, "archive"), { recursive: true });
    const archivedPath = join(sessionDir, "archive", "sub.jsonl");
    renameSync(livePath, archivedPath);
    expect(existsSync(livePath)).toBe(false);

    const sessionCtx = ctx({
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [],
        getSessionDir: () => sessionDir,
      },
    });
    vi.mocked(runAgent).mockClear();
    // Resumed by ALIAS: the session name is the only thing on disk that still
    // carries it, and `scanArchiveSessions` is what reads that name back.
    const result = await resume(tools, alias, sessionCtx);
    await flush();

    expect(textOf(result)).toContain("resumed from disk in background");
    expect(textOf(result)).not.toContain("Agent not found");
    const resumeOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(resumeOpts.resumeSessionFile).toBe(archivedPath);
    await lifecycle.get("session_shutdown")?.({}, sessionCtx);
  });

  it("reopens by handle from a session file pi's own listing scans", async () => {
    // The normal path for a persisted run: the session file sits in pi's
    // session dir for the cwd, and its `session_info` name carries the agent's
    // identity. Once the record is reaped, that name is the only link left —
    // and `SessionManager.list` is what finds it.
    const { tools } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools, { name: "auth-audit" });
    await flush();
    const sessionDir = join(
      process.env.PI_CODING_AGENT_DIR!,
      "sessions",
      // pi's own encoding: `C:\a\b` → `--C--a-b--`. Written out with split/join
      // rather than a regex class so no backslash can be lost in an edit.
      `--${process.cwd().split(/[/\\:]/).join("-")}--`,
    );
    mkdirSync(sessionDir, { recursive: true });
    writeSessionFile(join(sessionDir, "sub.jsonl"), id, ["general-purpose", "general-purpose", "auth-audit", id.slice(0, 8)]);
    await reap(id);
    expect(existsSync(join(sessionDir, "sub.jsonl"))).toBe(true);

    vi.mocked(runAgent).mockClear();
    const result = await resume(tools, "auth-audit");
    await flush();

    expect(textOf(result)).toContain("resumed from disk in background");
    const resumeOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(resumeOpts.resumeSessionFile).toBe(join(sessionDir, "sub.jsonl"));
  });

  it("keeps a fresh process's resume working from the transcript alone", async () => {
    // A restart has no records at all — this is the "new pi process opens a
    // week-old conversation" case, answered entirely from the transcript root.
    const { tools, lifecycle } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    await reap(id);
    // Simulate the process boundary: nothing in memory, then a new boot would
    // construct a fresh manager. The lookup below is what that manager does.
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    await lifecycle.get("session_shutdown")?.({}, ctx());

    vi.mocked(runAgent).mockClear();
    const result = await resume(tools, id);
    await flush();

    expect(textOf(result)).toContain("resumed from disk in background");
    const resumeOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(resumeOpts.resumeSessionFile.endsWith(`recovered-${id}.jsonl`)).toBe(true);
  });
});

describe("scanArchiveSessions (fork-side archive fallback)", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  function writeArchive(dir: string, name: string, lines: string[]) {
    mkdirSync(join(dir, "archive"), { recursive: true });
    writeFileSync(join(dir, "archive", name), lines.join("\n") + "\n");
  }

  const header = (id: string) =>
    JSON.stringify({ type: "session", version: 1, id, timestamp: new Date().toISOString(), cwd: "/proj" });
  const info = (name: string) => JSON.stringify({ type: "session_info", name });
  const msg = () => JSON.stringify({ type: "message", message: { role: "user", content: "hi" } });

  /** Minimal id/name matcher in the shape of findSessionOnDisk's. */
  const match = (wantId?: string, wantName?: string) =>
    (s: { name?: string; id?: string; path?: string }) => {
      if (wantId && s.id === wantId) return { path: s.path!, type: "general-purpose", name: s.name };
      if (wantName && (s.name ?? "").toLowerCase() === wantName.toLowerCase()) {
        return { path: s.path!, type: "general-purpose", name: s.name };
      }
      return undefined;
    };

  it("finds an archived session by header id without reading names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-scan-"));
    try {
      const id = "11111111-2222-3333-4444-555555555555";
      writeArchive(dir, "2026-01-01_abc.jsonl", [header(id), msg()]);
      const hits = scanArchiveSessions(dir, match(id), false);
      expect(hits).toHaveLength(1);
      expect(hits[0].path).toBe(join(dir, "archive", "2026-01-01_abc.jsonl"));
    } finally {
      hermeticDirCleanup(dir);
    }
  });

  it("matches session_info names only in the full pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-scan-"));
    try {
      writeArchive(dir, "2026-01-01_abc.jsonl", [header("11111111-2222-3333-4444-555555555555"), info("Explore#abc"), msg()]);

      // Cheap pass reads the header only, so a name query misses.
      expect(scanArchiveSessions(dir, match(undefined, "Explore#abc"), false)).toHaveLength(0);
      // Full pass reads session_info lines, so it hits.
      expect(scanArchiveSessions(dir, match(undefined, "Explore#abc"), true)).toHaveLength(1);
    } finally {
      hermeticDirCleanup(dir);
    }
  });

  it("ignores non-jsonl files and a missing archive dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-scan-"));
    try {
      expect(scanArchiveSessions(dir, match("11111111-2222-3333-4444-555555555555"), false)).toHaveLength(0);
      mkdirSync(join(dir, "archive"), { recursive: true });
      writeFileSync(join(dir, "archive", "notes.txt"), "hello");
      expect(scanArchiveSessions(dir, match("11111111-2222-3333-4444-555555555555"), false)).toHaveLength(0);
    } finally {
      hermeticDirCleanup(dir);
    }
  });

  it("skips files whose header does not parse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-scan-"));
    try {
      writeArchive(dir, "2026-01-01_abc.jsonl", ["not json {{{", msg()]);
      expect(scanArchiveSessions(dir, match("11111111-2222-3333-4444-555555555555"), true)).toHaveLength(0);
    } finally {
      hermeticDirCleanup(dir);
    }
  });
});

/** rmSync on a directory this test created itself. */
function hermeticDirCleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
