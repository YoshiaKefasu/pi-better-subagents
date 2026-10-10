/**
 * Read the subagent retry policy from pi's settings.json files.
 *
 * The project file overrides the global file per field, matching pi's own
 * settings precedence. This is intentionally separate from subagents.json:
 * retry policy belongs to pi's settings surface, while the extension's
 * operational settings remain in subagents.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SubagentsRetrySettings {
  enabled: boolean;
  /** Maximum number of attempts, including the initial run. */
  maxAttempts: number;
  /** Delay before each resume attempt. */
  baseDelayMs: number;
  /**
   * Maximum attempts for transient (connection-establishment/timeout) failures,
   * including the initial run. Thicker than maxAttempts: a transient failure
   * usually clears if the same request is resent.
   */
  transientMaxAttempts: number;
  /** Base delay before each transient resume attempt (exponential backoff). */
  transientBaseDelayMs: number;
  /** Cap for one transient backoff delay. */
  transientBackoffCapMs: number;
  /**
   * Overall retry budget starting at the first retry. Exceeded -> give up.
   * Applies to both families. 0 disables the elapsed cap (attempts only).
   */
  maxElapsedMs: number;
}

export const DEFAULT_SUBAGENTS_RETRY_SETTINGS: SubagentsRetrySettings = {
  enabled: true,
  maxAttempts: 5,
  baseDelayMs: 1200,
  transientMaxAttempts: 8,
  transientBaseDelayMs: 5000,
  transientBackoffCapMs: 60_000,
  maxElapsedMs: 180_000,
};

const MAX_ATTEMPTS_CEILING = 100;
const BASE_DELAY_MS_CEILING = 300_000;
const TRANSIENT_MAX_ATTEMPTS_CEILING = 100;
const TRANSIENT_BASE_DELAY_MS_CEILING = 300_000;
const TRANSIENT_BACKOFF_CAP_MS_CEILING = 600_000;
const MAX_ELAPSED_MS_CEILING = 3_600_000;

type PartialRetrySettings = Partial<SubagentsRetrySettings>;

function settingsPaths(cwd: string): [project: string, global: string] {
  return [
    join(cwd, ".pi", "settings.json"),
    join(getAgentDir(), "settings.json"),
  ];
}

function readRetrySection(path: string): PartialRetrySettings {
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const section = (raw as Record<string, unknown>)["subagents-retry"];
    if (!section || typeof section !== "object" || Array.isArray(section)) return {};
    const value = section as Record<string, unknown>;
    const result: PartialRetrySettings = {};
    // 棄却フィールドは stderr 警告する (黙って既定値に戻すと、maxAttempts: 0 の
    // つもりが default ON のまま5回試行する等の齟齬になる)。無効値の扱いは
    // 「棄却+警告」に統一し、disable としての解釈は enabled: false のみとする。
    const reject = (field: string, hint: string) =>
      console.warn(`[pi-subagents] Ignoring invalid subagents-retry.${field} in ${path} (${hint}).`);
    if (value.enabled === undefined) { /* unset — default applies */ }
    else if (typeof value.enabled === "boolean") result.enabled = value.enabled;
    else reject("enabled", "expected a boolean");
    if (value.maxAttempts === undefined) { /* unset — default applies */ }
    else if (
      Number.isInteger(value.maxAttempts) &&
      (value.maxAttempts as number) >= 1 &&
      (value.maxAttempts as number) <= MAX_ATTEMPTS_CEILING
    ) {
      result.maxAttempts = value.maxAttempts as number;
    } else {
      reject("maxAttempts", `expected an integer 1-${MAX_ATTEMPTS_CEILING}`);
    }
    if (value.baseDelayMs === undefined) { /* unset — default applies */ }
    else if (
      Number.isInteger(value.baseDelayMs) &&
      (value.baseDelayMs as number) >= 0 &&
      (value.baseDelayMs as number) <= BASE_DELAY_MS_CEILING
    ) {
      result.baseDelayMs = value.baseDelayMs as number;
    } else {
      reject("baseDelayMs", `expected an integer 0-${BASE_DELAY_MS_CEILING}`);
    }
    if (value.transientMaxAttempts === undefined) { /* unset — default applies */ }
    else if (
      Number.isInteger(value.transientMaxAttempts) &&
      (value.transientMaxAttempts as number) >= 1 &&
      (value.transientMaxAttempts as number) <= TRANSIENT_MAX_ATTEMPTS_CEILING
    ) {
      result.transientMaxAttempts = value.transientMaxAttempts as number;
    } else {
      reject("transientMaxAttempts", `expected an integer 1-${TRANSIENT_MAX_ATTEMPTS_CEILING}`);
    }
    if (value.transientBaseDelayMs === undefined) { /* unset — default applies */ }
    else if (
      Number.isInteger(value.transientBaseDelayMs) &&
      (value.transientBaseDelayMs as number) >= 0 &&
      (value.transientBaseDelayMs as number) <= TRANSIENT_BASE_DELAY_MS_CEILING
    ) {
      result.transientBaseDelayMs = value.transientBaseDelayMs as number;
    } else {
      reject("transientBaseDelayMs", `expected an integer 0-${TRANSIENT_BASE_DELAY_MS_CEILING}`);
    }
    if (value.transientBackoffCapMs === undefined) { /* unset — default applies */ }
    else if (
      Number.isInteger(value.transientBackoffCapMs) &&
      (value.transientBackoffCapMs as number) >= 0 &&
      (value.transientBackoffCapMs as number) <= TRANSIENT_BACKOFF_CAP_MS_CEILING
    ) {
      result.transientBackoffCapMs = value.transientBackoffCapMs as number;
    } else {
      reject("transientBackoffCapMs", `expected an integer 0-${TRANSIENT_BACKOFF_CAP_MS_CEILING}`);
    }
    if (value.maxElapsedMs === undefined) { /* unset — default applies */ }
    else if (
      Number.isInteger(value.maxElapsedMs) &&
      (value.maxElapsedMs as number) >= 0 &&
      (value.maxElapsedMs as number) <= MAX_ELAPSED_MS_CEILING
    ) {
      result.maxElapsedMs = value.maxElapsedMs as number;
    } else {
      reject("maxElapsedMs", `expected an integer 0-${MAX_ELAPSED_MS_CEILING}`);
    }
    return result;
  } catch {
    return {};
  }
}

/** Load the merged subagent retry policy for a project. */
export function loadSubagentsRetrySettings(cwd: string = process.cwd()): SubagentsRetrySettings {
  const [project, global] = settingsPaths(cwd);
  return {
    ...DEFAULT_SUBAGENTS_RETRY_SETTINGS,
    ...readRetrySection(global),
    ...readRetrySection(project),
  };
}
