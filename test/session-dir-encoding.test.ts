/**
 * session-dir-encoding.test.ts — regression guard for the session-dir encoding.
 *
 * This file started life as a debug scratch file, written to diagnose a recovery
 * helper that returned `undefined` on Windows because its regex had lost its
 * backslashes. The bug is fixed, the general rebuild behaviour is covered by
 * test/output-file-recovery.test.ts, and what lives on here is the one invariant
 * that scratch file was created to prove — a session rebuilt from a transcript
 * must land in the directory pi's own `SessionManager.list` scans.
 *
 * That invariant is easy to break silently: the fork's transcript encoder
 * (`encodeCwd`) drops the Windows drive prefix, pi's session-dir encoder keeps
 * it, and a file written to the wrong place still resumes fine when its path is
 * handed to `SessionManager.open` directly — it just never shows up in
 * `/resume`, and `findSessionOnDisk` cannot find it either.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeSessionFromOutputFile, sessionTaskDir } from "../src/output-file.js";

/** A cwd whose drive letter is exactly what the two encoders disagree about. */
const CWD = String.raw`C:\Users\yosia\project`;

let agentDir: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = mkdtempSync(join(tmpdir(), "pi-sessiondir-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("recovered session lands in pi's own session dir", () => {
  const AGENT = "480c2bd8-98c0-4a57-b89a-29ce5a3fec22";

  it("is discoverable by SessionManager.list for that cwd", async () => {
    const tasksDir = sessionTaskDir(CWD, "s1");
    const transcript = join(tasksDir, `${AGENT}.output`);
    writeFileSync(transcript, `${JSON.stringify({
      isSidechain: true,
      agentId: AGENT,
      type: "user",
      message: { role: "user", content: "audit the RPC path" },
      timestamp: new Date().toISOString(),
      cwd: CWD,
    })}\n`, "utf-8");

    const recovered = materializeSessionFromOutputFile(transcript, CWD, undefined, "Explore");
    expect(recovered).toBeTruthy();

    // The assertion the scratch file was written for: pi's own listing sees it.
    const sessions = await SessionManager.list(CWD);
    expect(sessions.map((s) => s.path)).toContain(recovered);
  });

  it("keeps the encoding pi uses, drive letter and all", async () => {
    const tasksDir = sessionTaskDir(CWD, "s1");
    const transcript = join(tasksDir, `${AGENT}.output`);
    writeFileSync(transcript, `${JSON.stringify({
      isSidechain: true,
      agentId: AGENT,
      type: "user",
      message: { role: "user", content: "go" },
      timestamp: new Date().toISOString(),
      cwd: CWD,
    })}\n`, "utf-8");

    const recovered = materializeSessionFromOutputFile(transcript, CWD)!;
    // `C:\Users\yosia\project` → `--C--Users-yosia-project--`: NOT the fork's
    // `--Users-yosia-project--`, which is what encodeCwd produces.
    expect(recovered).toBe(
      join(agentDir, "sessions", "--C--Users-yosia-project--", `recovered-${AGENT}.jsonl`),
    );
  });
});
