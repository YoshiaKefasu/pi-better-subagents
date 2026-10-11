// README publishes concrete default values (Persistent settings, README:441).
// Every existing test that looked like it checked one actually SET the value
// first — `test/agent-runner-settings.test.ts` had a `beforeEach(setGraceTurns(5))`
// followed by `it("defaults to 5")`, which asserts the setter, not the default.
//
// The defaults live in module-level `let`s that the settings appliers overwrite
// at boot, so reading them after any other suite has run tells you nothing.
// `vi.resetModules()` + a dynamic import gives a genuinely fresh module, which
// is why this lives in its own file: resetModules is file-wide and hostile to
// suites that hold module references across tests.

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("documented defaults (README:441)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // src/agent-runner.js pulls in the whole pi-coding-agent graph, and
  // `server.deps.inline` means resetModules re-transforms all of it — several
  // seconds under a loaded full run, versus instant in isolation. The default
  // 5s timeout makes these two flaky, so they get an explicit generous one
  // rather than a retry.
  const HEAVY_REIMPORT_MS = 60_000;

  it("grace turns after the soft limit default to 5", async () => {
    const { getGraceTurns } = await import("../src/agent-runner.js");
    expect(getGraceTurns()).toBe(5);
  }, HEAVY_REIMPORT_MS);

  it("max turns is unlimited by default", async () => {
    const { getDefaultMaxTurns } = await import("../src/agent-runner.js");
    expect(getDefaultMaxTurns()).toBeUndefined();
  }, HEAVY_REIMPORT_MS);

  it("nested subagent depth defaults to 2", async () => {
    const { getMaxSubagentDepth } = await import("../src/nested-tools.js");
    expect(getMaxSubagentDepth()).toBe(2);
  });

  // Raised from 4 when top-level spawns started defaulting to background: every
  // top-level agent then takes a slot, so a limit tuned for opt-in background
  // would now queue the tail of ordinary parallel fan-outs.
  it("background concurrency defaults to 10", async () => {
    const { AgentManager } = await import("../src/agent-manager.js");
    const manager = new AgentManager();
    try {
      expect(manager.getMaxConcurrent()).toBe(10);
    } finally {
      manager.dispose();
    }
  });

  // There is no foreground pool any more, so there is no foreground limit to
  // publish: the manager exposes exactly one concurrency knob.
  it("exposes no foreground concurrency setting at all", async () => {
    const { AgentManager } = await import("../src/agent-manager.js");
    const manager = new AgentManager();
    try {
      // The retired pair is gone from the instance, not merely defaulted off —
      // a stale key in a user's settings file cannot resurrect it either.
      expect("setMaxConcurrentForeground" in manager).toBe(false);
      expect("getMaxConcurrentForeground" in manager).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  it("model scope is off by default", async () => {
    // Off is the safe default: on, an unconfigured enabledModels would start
    // refusing spawns. README:428 documents it as opt-in.
    const { isScopeModelsEnabled } = await import("../src/model-scope.js");
    expect(isScopeModelsEnabled()).toBe(false);
  });
});
