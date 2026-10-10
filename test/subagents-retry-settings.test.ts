import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retrySettingsAgentDir = vi.hoisted(() => ({ value: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => retrySettingsAgentDir.value,
}));

import {
  DEFAULT_SUBAGENTS_RETRY_SETTINGS,
  loadSubagentsRetrySettings,
} from "../src/subagents-retry-settings.js";

describe("subagents-retry settings", () => {
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "pi-subagents-retry-settings-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-subagents-retry-settings-project-"));
    retrySettingsAgentDir.value = globalDir;
  });

  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    retrySettingsAgentDir.value = "";
  });

  function writeSettings(path: string, value: unknown, global = false): void {
    const settingsPath = global ? join(path, "settings.json") : join(path, ".pi", "settings.json");
    mkdirSync(join(path, global ? "" : ".pi"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(value));
  }

  it("uses the documented defaults when the section is absent", () => {
    expect(loadSubagentsRetrySettings(projectDir)).toEqual(DEFAULT_SUBAGENTS_RETRY_SETTINGS);
  });

  it("merges global and project settings per field", () => {
    writeSettings(globalDir, { "subagents-retry": { enabled: false, maxAttempts: 2 } }, true);
    writeSettings(projectDir, { "subagents-retry": { baseDelayMs: 0 } });

    expect(loadSubagentsRetrySettings(projectDir)).toEqual({
      ...DEFAULT_SUBAGENTS_RETRY_SETTINGS,
      enabled: false,
      maxAttempts: 2,
      baseDelayMs: 0,
    });
  });

  it("ignores malformed sections and out-of-range values", () => {
    writeSettings(projectDir, {
      "subagents-retry": {
        enabled: "yes",
        maxAttempts: 0,
        baseDelayMs: -1,
      },
    });

    expect(loadSubagentsRetrySettings(projectDir)).toEqual(DEFAULT_SUBAGENTS_RETRY_SETTINGS);
  });

  it("loads transient budget and elapsed cap values", () => {
    writeSettings(projectDir, {
      "subagents-retry": {
        transientMaxAttempts: 10,
        transientBaseDelayMs: 5000,
        transientBackoffCapMs: 30_000,
        maxElapsedMs: 60_000,
      },
    });

    expect(loadSubagentsRetrySettings(projectDir)).toEqual({
      ...DEFAULT_SUBAGENTS_RETRY_SETTINGS,
      transientMaxAttempts: 10,
      transientBaseDelayMs: 5000,
      transientBackoffCapMs: 30_000,
      maxElapsedMs: 60_000,
    });
  });

  it("ignores out-of-range and mistyped transient/elapsed values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeSettings(projectDir, {
        "subagents-retry": {
          transientMaxAttempts: 0,
          transientBaseDelayMs: -1,
          transientBackoffCapMs: "fast",
          maxElapsedMs: 3_600_001,
        },
      });
      expect(loadSubagentsRetrySettings(projectDir)).toEqual(DEFAULT_SUBAGENTS_RETRY_SETTINGS);
      expect(warn).toHaveBeenCalledTimes(4);
      expect(warn.mock.calls[0][0]).toContain("subagents-retry.transientMaxAttempts");
      expect(warn.mock.calls[1][0]).toContain("subagents-retry.transientBaseDelayMs");
      expect(warn.mock.calls[2][0]).toContain("subagents-retry.transientBackoffCapMs");
      expect(warn.mock.calls[3][0]).toContain("subagents-retry.maxElapsedMs");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns on stderr for each rejected field", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeSettings(projectDir, {
        "subagents-retry": {
          enabled: "yes",
          maxAttempts: 0,
          baseDelayMs: -1,
        },
      });
      loadSubagentsRetrySettings(projectDir);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[0][0]).toContain("subagents-retry.enabled");
      expect(warn.mock.calls[1][0]).toContain("subagents-retry.maxAttempts");
      expect(warn.mock.calls[2][0]).toContain("subagents-retry.baseDelayMs");
    } finally {
      warn.mockRestore();
    }
  });
});
