// README: transcript root is owner-only `0700`. Transcripts hold the agent's
// full conversation — user prompts, file contents, tool output — so that mode
// is the only thing keeping them from other local users. The root used to be
// `<os-tmpdir>/pi-subagents-<uid>` (swept on reboot, shared with every worker
// and e2e suite); it is now fork-owned under `<agentDir>/tmp/subagents-output`.
// `PI_CODING_AGENT_DIR` is redirected per test because `getAgentDir()` reads it
// on every call — no module mock needed.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOutputFilePath, encodeCwd } from "../src/output-file.js";

const AGENT = "agent-xyz";
const SESSION = "session-123";

describe("createOutputFilePath", () => {
  let agentDir: string;
  let prevAgentDir: string | undefined;
  let root: string;

  beforeEach(() => {
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = mkdtempSync(join(tmpdir(), "pi-outpath-agentdir-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    root = join(agentDir, "tmp", "subagents-output");
  });

  afterEach(() => {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("builds the documented layout: <agentDir>/tmp/subagents-output/<encoded-cwd>/<session>/tasks/<agent>.output", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(path).toBe(join(root, "home-user-project", SESSION, "tasks", `${AGENT}.output`));
    expect(encodeCwd("/home/user/project")).toBe("home-user-project");
  });

  it("creates the directory chain so the first write cannot fail", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(existsSync(join(path, ".."))).toBe(true);
    expect(statSync(join(path, "..")).isDirectory()).toBe(true);
  });

  it("keeps distinct cwds in separate subdirectories under the shared root", () => {
    const a = createOutputFilePath("/home/user/project", AGENT, SESSION);
    const b = createOutputFilePath("/home/user/other", "agent-2", SESSION);
    expect(a).toContain("home-user-project");
    expect(b).toContain("home-user-other");
    expect(a).not.toBe(b);
  });

  it("no longer places transcripts under the OS temp sweep", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(path).not.toContain("pi-subagents-");
  });

  it.skipIf(process.platform === "win32")("creates the root owner-only", () => {
    createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("re-tightens a pre-existing world-readable root", () => {
    // The case the explicit chmod exists for. `mkdirSync(recursive: true)` does
    // NOT alter an existing directory's mode, so a root left behind by an older
    // version — or created by anything else under a permissive umask — would
    // keep its wide permissions and every transcript written into it would be
    // readable by every local user. (mkdir's own `mode: 0o700` cannot cover
    // this: umask only clears bits, so a fresh mkdir is never too permissive.)
    // Note only the fork-owned `subagents-output` root is tightened — the
    // shared `tmp/` above it is created but never chmodded.
    mkdirSync(root, { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755); // defeat umask so the premise really holds
    expect(statSync(root).mode & 0o777).toBe(0o755);

    createOutputFilePath("/home/user/project", AGENT, SESSION);

    expect(statSync(root).mode & 0o777).toBe(0o700);
  });
});
