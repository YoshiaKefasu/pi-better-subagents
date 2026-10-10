import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveSettingsPath, persistArchiveConfig } from "../src/archive-settings.js";
import { DEFAULT_ARCHIVE_AGE_HOURS, readArchiveConfig } from "../src/session-archive.js";

/**
 * Tests for persisting the `session-archive` section into pi's project
 * settings (`<cwd>/.pi/settings.json`) — the save half of the pair that
 * `session-archive.ts` reads. Uses two tmp directories:
 * - `globalDir`: redirected via PI_CODING_AGENT_DIR so getAgentDir() returns
 *   it — keeps `readArchiveConfig`'s global read hermetic.
 * - `projectDir`: passed explicitly as cwd; settings live at
 *   `<projectDir>/.pi/settings.json`.
 */
describe("session-archive settings persistence", () => {
  let globalDir: string;
  let projectDir: string;
  let originalAgentDirEnv: string | undefined;

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "pi-archive-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-archive-project-"));
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
  });

  afterEach(() => {
    if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  const projectFile = () => archiveSettingsPath(projectDir);

  it("creates .pi/settings.json with the session-archive section when missing", () => {
    expect(existsSync(projectFile())).toBe(false);

    const ok = persistArchiveConfig(projectDir, { enabled: true, maxAgeHours: 24 });

    expect(ok).toBe(true);
    expect(existsSync(projectFile())).toBe(true);
    expect(JSON.parse(readFileSync(projectFile(), "utf8"))).toEqual({
      "session-archive": { enabled: true, maxAgeHours: 24 },
    });
    // The read half sees exactly what the write half stored.
    expect(readArchiveConfig(projectDir)).toEqual({ enabled: true, maxAgeHours: 24 });
  });

  it("writes only the section and preserves every other pi settings key", () => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      projectFile(),
      JSON.stringify({ theme: "dark", httpIdleTimeoutMs: 300000, "session-archive": { enabled: true, maxAgeHours: 12 } }),
    );

    persistArchiveConfig(projectDir, { enabled: false, maxAgeHours: 48 });

    expect(JSON.parse(readFileSync(projectFile(), "utf8"))).toEqual({
      theme: "dark",
      httpIdleTimeoutMs: 300000,
      "session-archive": { enabled: false, maxAgeHours: 48 },
    });
  });

  it("persists an explicit off rather than erasing the section", () => {
    persistArchiveConfig(projectDir, { enabled: false, maxAgeHours: DEFAULT_ARCHIVE_AGE_HOURS });
    expect(readArchiveConfig(projectDir)).toEqual({ enabled: false, maxAgeHours: DEFAULT_ARCHIVE_AGE_HOURS });
  });

  it("round-trips maxAgeHours changes", () => {
    persistArchiveConfig(projectDir, { enabled: true, maxAgeHours: 6 });
    persistArchiveConfig(projectDir, { enabled: true, maxAgeHours: 168 });
    expect(readArchiveConfig(projectDir)).toEqual({ enabled: true, maxAgeHours: 168 });
  });

  it("recovers a corrupt existing settings.json instead of refusing to write", () => {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), "not json {{");

    const ok = persistArchiveConfig(projectDir, { enabled: true, maxAgeHours: 24 });

    expect(ok).toBe(true);
    expect(JSON.parse(readFileSync(projectFile(), "utf8"))).toEqual({
      "session-archive": { enabled: true, maxAgeHours: 24 },
    });
  });

  it("reports a failed write instead of throwing", () => {
    // A plain file where `.pi/` would live makes the mkdir fail.
    const blocker = join(tmpdir(), "pi-archive-blocker-file");
    writeFileSync(blocker, "i am a file, not a directory");

    const ok = persistArchiveConfig(blocker, { enabled: true, maxAgeHours: 24 });

    expect(ok).toBe(false);
    rmSync(blocker, { force: true });
  });
});