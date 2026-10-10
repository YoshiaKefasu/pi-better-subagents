/**
 * tombstone-session-switch.test.ts — tombstone resume across the paths that
 * used to destroy it, through the REAL extension wiring.
 *
 * 1. `session_start` (and `session_before_switch`, which calls the same
 *    `clearCompleted(true)`) no longer wipes tombstones: a GC-evicted agent
 *    stays resumable by handle after the switch.
 * 2. When pi's session-archive moves the transcript into `archive/`, both the
 *    tombstone resume and the fork-side `scanArchiveSessions` fallback still
 *    find it.
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

/** Boot the real extension. `outputTranscript: false` keeps the run off disk. */
function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "find flaky tests", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const managerOf = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];

/** Age the record past the cutoff and let the real GC evict it into a tombstone. */
async function evict(id: string, sessionFile: string) {
  const manager = managerOf();
  const record = manager.getRecord(id);
  record.sessionFile = sessionFile;
  writeFileSync(sessionFile, "");
  const handle = record.handle;
  record.completedAt = Date.now() - 11 * 60_000;
  await vi.advanceTimersByTimeAsync(60_000);
  // Evicted from live memory (`resolveAgentRef` sees live records only),
  // so whatever answers the resume below must come from the tombstone.
  expect(manager.getRecord(id)).toBeUndefined();
  expect(manager.resolveAgentRef(handle)).toBeUndefined();
  return { manager, handle };
}

async function resumeByHandle(tools: Map<string, any>, handle: string, sessionCtx: any) {
  finishedRun(fakeSession(), "resumed answer");
  return tools.get("Agent").execute(
    "tc-resume",
    { prompt: "follow-up", description: "Follow-up", subagent_type: "general-purpose", resume: handle, run_in_background: false },
    undefined,
    undefined,
    sessionCtx,
  );
}

describe("tombstone resume across session boundaries", () => {
  // Only the GC interval and Date are faked: `flush()` runs on setImmediate,
  // and the manager's cleanup timer is started in its constructor, so the
  // fake clock has to be installed before boot().
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("stays resumable by handle after session_start (no more wipe on switch)", async () => {
    const { tools, lifecycle } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    const sessionFile = join(process.cwd(), "switched-session.jsonl");
    const { handle } = await evict(id, sessionFile);

    // The old behavior wiped every tombstone here; now they are kept —
    // proved below by the resume answering from the tombstone, not `Agent not
    // found`. (The registry facade exposes live records only, so the check
    // has to go through the real resume path.)
    await lifecycle.get("session_start")?.({}, ctx());

    vi.mocked(runAgent).mockClear();
    const result = await resumeByHandle(tools, handle, ctx());
    await flush();

    expect(textOf(result)).toContain("resumed answer");
    expect(textOf(result)).not.toContain("Agent not found");
    const resumeOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(resumeOpts.resumeSessionFile).toBe(sessionFile);
    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("finds the transcript in archive/ after session-archive moved it", async () => {
    const { tools, lifecycle } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    // sessionDir は pi が握る実ディレクトリ、archive/ はその配下という実配置。
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-switch-sessiondir-"));
    const sessionFile = join(process.cwd(), "archived-session.jsonl");
    const { handle } = await evict(id, sessionFile);
    mkdirSync(join(sessionDir, "archive"), { recursive: true });
    const archivedPath = join(sessionDir, "archive", "archived-session.jsonl");
    renameSync(sessionFile, archivedPath);
    expect(existsSync(sessionFile)).toBe(false);

    const sessionCtx = ctx({
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [],
        getSessionDir: () => sessionDir,
      },
    });
    vi.mocked(runAgent).mockClear();
    const result = await resumeByHandle(tools, handle, sessionCtx);
    await flush();

    expect(textOf(result)).toContain("resumed answer");
    expect(textOf(result)).not.toContain("Agent not found");
    // archive sibling が reopen 元として渡される。
    const resumeOpts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(resumeOpts.resumeSessionFile).toBe(archivedPath);
    await lifecycle.get("session_shutdown")?.({}, sessionCtx);
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
      const id = "22222222-2222-3333-4444-555555555555";
      writeArchive(dir, "2026-01-02_def.jsonl", [header(id), info("executor#deadbeef"), msg()]);
      // Header-only pass: name matching is impossible, id matching still works.
      expect(scanArchiveSessions(dir, match(undefined, "executor#deadbeef"), false)).toHaveLength(0);
      expect(scanArchiveSessions(dir, match(id), false)).toHaveLength(1);
      // Full pass: the name resolves.
      const hits = scanArchiveSessions(dir, match(undefined, "executor#deadbeef"), true);
      expect(hits).toHaveLength(1);
      expect(hits[0].name).toBe("executor#deadbeef");
    } finally {
      hermeticDirCleanup(dir);
    }
  });

  it("ignores non-jsonl files and a missing archive dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-scan-"));
    try {
      writeArchive(dir, "notes.txt", [header("33333333-2222-3333-4444-555555555555")]);
      expect(scanArchiveSessions(dir, match("33333333-2222-3333-4444-555555555555"), true)).toHaveLength(0);
      const missing = join(tmpdir(), "pi-scan-does-not-exist-xyz");
      expect(scanArchiveSessions(missing, match("x"), true)).toEqual([]);
    } finally {
      hermeticDirCleanup(dir);
    }
  });

  it("skips files whose header does not parse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-scan-"));
    try {
      writeArchive(dir, "broken.jsonl", ["{{{not json", msg()]);
      expect(scanArchiveSessions(dir, match("anything"), true)).toHaveLength(0);
    } finally {
      hermeticDirCleanup(dir);
    }
  });
});

function hermeticDirCleanup(dir: string) {
  // Local temp dirs only — never touch the hermetic agent dir owned by boot().
  rmSync(dir, { recursive: true, force: true });
}
