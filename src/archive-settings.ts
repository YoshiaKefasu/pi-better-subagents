/**
 * Persist the `session-archive` section into pi's project settings
 * (`<cwd>/.pi/settings.json`). This is the *write* half of the pair that
 * `src/session-archive.ts` reads: that module owns reading (`readArchiveConfig`,
 * project wins over global per field), and this module owns the save path the
 * `/agents → Settings` screen uses. It deliberately does not touch pi's
 * global `<agentDir>/settings.json` — the Settings screen's project-scoped
 * sibling `subagents.json` is written the same way (see `src/settings.ts`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionArchiveConfig } from "./session-archive.js";

/** Project-scope pi settings file — the one `readArchiveConfig` lets win. */
export function archiveSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

/**
 * Merge `config` into the `session-archive` section of the project
 * settings.json, preserving every other key pi or the user may have written
 * there. Creates `.pi/settings.json` on demand; a missing or corrupt file is
 * treated as empty (a corrupt file is overwritten with just our section).
 *
 * Returns `false` if the write (or mkdir) failed so the caller can surface a
 * warning — persistence isn't fatal but isn't silent, mirroring
 * `src/settings.ts:saveSettings`.
 */
export function persistArchiveConfig(cwd: string, config: SessionArchiveConfig): boolean {
  const path = archiveSettingsPath(cwd);
  try {
    let current: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        // Corrupt settings file — overwrite with just our section rather than
        // refusing to run (the readers treat a corrupt file the same way).
      }
    }
    current["session-archive"] = { enabled: config.enabled, maxAgeHours: config.maxAgeHours };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(current, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}