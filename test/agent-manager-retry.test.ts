import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const retryAgentDir = vi.hoisted(() => ({ value: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => retryAgentDir.value,
}));

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { AgentManager, classifyRetryFailureFamily } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockSession = () => ({ dispose: vi.fn() } as any);

function configureRetry(settings: Record<string, unknown>): string {
  const projectDir = mkdtempSync(join(tmpdir(), "pi-subagents-retry-project-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ "subagents-retry": settings }));
  retryAgentDir.value = mkdtempSync(join(tmpdir(), "pi-subagents-retry-global-"));
  return projectDir;
}

describe("AgentManager — stream retry", () => {
  let manager: AgentManager | undefined;
  let projectDir: string | undefined;
  let currentId = "";

  afterEach(() => {
    manager?.dispose();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    retryAgentDir.value = "";
    vi.clearAllMocks();
  });

  it("resumes the same session after a retryable stream failure", async () => {
    projectDir = configureRetry({ enabled: true, maxAttempts: 3, baseDelayMs: 0 });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return {
        responseText: "",
        session,
        aborted: false,
        steered: false,
        failure: "stream disconnected before completion",
      };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "recovered" });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "retry me",
    });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).toHaveBeenCalledOnce();
    expect(vi.mocked(resumeAgent).mock.calls[0][0]).toBe(session);
    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      id,
      status: "completed",
      result: "recovered",
      session,
    }));
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it.each([
    // Exact errors emitted by @earendil-works/pi-ai@0.84.2 dist:
    // api/anthropic-messages.js, api/openai-completions.js,
    // api/google-generative-ai.js, api/openai-responses-shared.js, and
    // api/openai-codex-responses.js.
    "Anthropic stream ended before message_stop",
    "Stream ended without finish_reason",
    "Google stream ended without a finish reason",
    "OpenAI Responses stream ended before a terminal response event",
    "WebSocket stream closed before response.completed",
    // Transport-level disconnects (CPA-observed upstream TCP reset):
    'Post "https://api.experientiallabs.ai/v1/responses": read tcp 10.0.0.1:54321->93.184.216.34:443: wsarecv: An existing connection was forcibly closed by the remote host',
    "read tcp 10.0.0.1:54321->93.184.216.34:443: read: connection reset by peer",
    "socket hang up",
  ])("resumes after a provider stream termination: %s", async (failure) => {
    projectDir = configureRetry({ enabled: true, maxAttempts: 2, baseDelayMs: 0 });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return {
        responseText: "",
        session,
        aborted: false,
        steered: false,
        failure,
      };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "recovered" });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "retry provider stream termination",
    });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      status: "completed",
      result: "recovered",
    }));
  });

  it("stops after maxAttempts and preserves the final stream error", async () => {
    projectDir = configureRetry({ enabled: true, maxAttempts: 3, baseDelayMs: 0 });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      throw new Error("stream closed before response.completed");
    });
    vi.mocked(resumeAgent).mockRejectedValue(new Error("upstream execution failed"));

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "retry me",
    });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).toHaveBeenCalledTimes(2);
    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      status: "error",
      error: "upstream execution failed",
    }));
  });

  it("does not retry a non-retryable error even with retries enabled", async () => {
    // 分類が none になる失敗（認証失敗）。enabled: true でも retryable ではない。
    projectDir = configureRetry({ enabled: true, maxAttempts: 3, baseDelayMs: 0 });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      throw new Error("authentication failed");
    });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "no retry for non-stream error",
    });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).not.toHaveBeenCalled();
    expect(manager.getRecord(id)?.error).toBe("authentication failed");
  });

  it("does not retry anything when disabled — even a retryable error", async () => {
    // enabled: false が実際に効く証拠。retryable な文言を使うことで、
    // enabled を無視する実装（enabled: true と同じ挙動）では通らない。
    projectDir = configureRetry({ enabled: false, maxAttempts: 5, baseDelayMs: 0 });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      throw new Error("stream disconnected before completion");
    });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "disabled means disabled",
    });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).not.toHaveBeenCalled();
    expect(manager.getRecord(id)?.status).toBe("error");
    expect(manager.getRecord(id)?.error).toBe("stream disconnected before completion");
  });

  it("maxElapsedMs: 0 disables the time budget (attempt budget still applies)", async () => {
    projectDir = configureRetry({
      enabled: true,
      maxAttempts: 2,
      baseDelayMs: 0,
      transientMaxAttempts: 2,
      transientBaseDelayMs: 0,
      maxElapsedMs: 0,
    });
    const session = mockSession();
    // 常に transient 失敗を返す。maxElapsedMs: 0 なら時間で切れず、
    // transient 予算 2 で停止する（= resumeAgent 1回）。
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      throw new Error("fetch failed");
    });
    vi.mocked(resumeAgent).mockRejectedValue(new Error("fetch failed"));

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "time budget off",
    });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(id)?.status).toBe("error");
  });

  it("stops retrying when the agent is aborted mid-transient-retry", async () => {
    // 今回いちばん脆い経路: 再送待ちの最中に abort されても、
    // それ以上 resumeAgent を呼ばないこと。
    projectDir = configureRetry({
      enabled: true,
      maxAttempts: 2,
      baseDelayMs: 0,
      transientMaxAttempts: 8,
      transientBaseDelayMs: 50,
      maxElapsedMs: 0,
    });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      throw new Error("fetch failed");
    });
    // 初回再送で abort を仕込む。2回目以降は絶対に呼ばれない。
    let abortArmed = false;
    vi.mocked(resumeAgent).mockImplementation(async (_session: unknown, _prompt: string) => {
      if (!abortArmed) {
        abortArmed = true;
        const rec = manager?.getRecord(currentId);
        if (rec !== undefined) manager!.abort(currentId);
        throw new Error("fetch failed");
      }
      throw new Error("SHOULD NOT BE REACHED: retry continued past abort");
    });

    manager = new AgentManager();
    currentId = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "abort during transient retry",
    });
    await manager.getRecord(currentId)!.promise;

    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(currentId)?.status).toBe("stopped");
  });

  it("does not retry a structured spawn: the schema contract would go stale", async () => {
    // retry は schema の無い resumeAgent で継続するため、成功しても
    // structuredJson が古いまま completed になる。除外を選んだことの証拠。
    projectDir = configureRetry({ enabled: true, maxAttempts: 3, baseDelayMs: 0 });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return {
        responseText: "",
        session,
        aborted: false,
        steered: false,
        failure: "stream disconnected before completion",
      };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "recovered" });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "structured, do not retry",
      structuredOutput: { schema: { type: "object" } } as any,
    });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).not.toHaveBeenCalled();
    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      status: "error",
      error: "stream disconnected before completion",
    }));
  });

  it("retries when the retryable text hides in an error cause chain", async () => {
    projectDir = configureRetry({ enabled: true, maxAttempts: 2, baseDelayMs: 0 });
    const session = mockSession();
    const wrapped = new Error("upstream wrapper") as Error & { cause?: unknown };
    wrapped.cause = new Error("socket hang up");
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      throw wrapped;
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "recovered" });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "wrapped cause",
    });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      status: "completed",
      result: "recovered",
    }));
  });

  it.each([
    // transient: 接続確立失敗・タイムアウト系は同一リクエスト再送で通る見込み。
    "fetch failed",
    "connect ETIMEDOUT 93.184.216.34:443",
    "AbortError: The operation was aborted",
  ])("retries a transient connection failure: %s", async (failure) => {
    projectDir = configureRetry({
      enabled: true,
      maxAttempts: 2,
      baseDelayMs: 0,
      transientMaxAttempts: 2,
      transientBaseDelayMs: 0,
      maxElapsedMs: 0,
    });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return {
        responseText: "",
        session,
        aborted: false,
        steered: false,
        failure,
      };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "recovered" });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "retry transient",
    });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      status: "completed",
      result: "recovered",
    }));
  });

  it("retries transient failures more times than stream failures", async () => {
    projectDir = configureRetry({
      enabled: true,
      maxAttempts: 2,
      baseDelayMs: 0,
      transientMaxAttempts: 4,
      transientBaseDelayMs: 0,
      maxElapsedMs: 0,
    });
    const session = mockSession();
    // 回復不能にして再送回数だけを比べる。stream は maxAttempts=2 → 再送 1 回、
    // transient は transientMaxAttempts=4 → 再送 3 回。
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      throw new Error("fetch failed");
    });
    vi.mocked(resumeAgent).mockImplementation(async (_session: unknown, prompt: string) => {
      // 再送プロンプトに埋めた failure 文言で失敗を再現する。
      throw new Error(prompt.includes("fetch failed") ? "fetch failed" : "stream disconnected before completion");
    });

    manager = new AgentManager();
    const transientId = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "transient budget",
    });
    await manager.getRecord(transientId)!.promise;
    // 初回 throw + transient 再送 3 回 = resumeAgent 3 回。
    expect(resumeAgent).toHaveBeenCalledTimes(3);
    expect(manager.getRecord(transientId)).toEqual(expect.objectContaining({
      status: "error",
      error: "fetch failed",
    }));

    vi.clearAllMocks();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      throw new Error("stream disconnected before completion");
    });
    vi.mocked(resumeAgent).mockRejectedValue(new Error("stream disconnected before completion"));
    const streamManager = new AgentManager();
    try {
      const streamId = streamManager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
        description: "stream budget",
      });
      await streamManager.getRecord(streamId)!.promise;
      // 初回 throw + stream 再送 1 回 = resumeAgent 1 回。transient（3 回）より薄い。
      expect(resumeAgent).toHaveBeenCalledTimes(1);
      expect(streamManager.getRecord(streamId)).toEqual(expect.objectContaining({
        status: "error",
        error: "stream disconnected before completion",
      }));
    } finally {
      streamManager.dispose();
    }
  });

  it("does not retry usage-limit (429) failures", async () => {
    projectDir = configureRetry({
      enabled: true,
      maxAttempts: 5,
      baseDelayMs: 0,
      transientMaxAttempts: 8,
      transientBaseDelayMs: 0,
      maxElapsedMs: 0,
    });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return {
        responseText: "",
        session,
        aborted: false,
        steered: false,
        failure: "status 429: rate limit exceeded",
      };
    });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "do not retry 429",
    });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).not.toHaveBeenCalled();
    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      status: "error",
      error: "status 429: rate limit exceeded",
    }));
  });

  it("gives up when maxElapsedMs is exceeded and keeps the final failure", async () => {
    projectDir = configureRetry({
      enabled: true,
      maxAttempts: 100,
      baseDelayMs: 0,
      transientMaxAttempts: 100,
      transientBaseDelayMs: 50,
      maxElapsedMs: 60,
    });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      throw new Error("fetch failed");
    });
    vi.mocked(resumeAgent).mockRejectedValue(new Error("fetch failed"));

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "elapsed budget",
    });
    await manager.getRecord(id)!.promise;

    // attempt 予算（100 回）より時間切れが先に効く。
    expect(vi.mocked(resumeAgent).mock.calls.length).toBeLessThan(99);
    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      status: "error",
      error: "fetch failed",
    }));
  });

  it("stops retrying when the failure changes to usage-limit", async () => {
    projectDir = configureRetry({
      enabled: true,
      maxAttempts: 100,
      baseDelayMs: 0,
      transientMaxAttempts: 100,
      transientBaseDelayMs: 0,
      maxElapsedMs: 0,
    });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      throw new Error("fetch failed");
    });
    vi.mocked(resumeAgent).mockRejectedValue(new Error("status 429: rate limit exceeded"));

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "continue", {
      description: "turns into 429",
    });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      status: "error",
      error: "status 429: rate limit exceeded",
    }));
  });

  it("retries a stream failure on the inline resume route", async () => {
    // resume 経路（startAgent の .then/.catch の外）でも自動リトライが働く証拠。
    projectDir = configureRetry({ enabled: true, maxAttempts: 3, baseDelayMs: 0 });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return { responseText: "first run done", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent)
      .mockResolvedValueOnce({ text: "", failure: "stream disconnected before completion" })
      .mockResolvedValueOnce({ text: "recovered" });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "kick off", {
      description: "inline resume retry",
    });
    await manager.getRecord(id)!.promise;

    const record = await manager.resume(id, "continue");

    // 初回 resume の切断 + 再送1回 = resumeAgent 2回。
    expect(resumeAgent).toHaveBeenCalledTimes(2);
    expect(record).toEqual(expect.objectContaining({
      status: "completed",
      result: "recovered",
    }));
  });

  it("retries a stream failure on the background resume route", async () => {
    // startResume（detached）側も同じゲートを通ることの証拠。
    projectDir = configureRetry({ enabled: true, maxAttempts: 3, baseDelayMs: 0 });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return { responseText: "first run done", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent)
      .mockResolvedValueOnce({ text: "", failure: "stream disconnected before completion" })
      .mockResolvedValueOnce({ text: "recovered" });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "kick off", {
      description: "background resume retry",
    });
    await manager.getRecord(id)!.promise;

    manager.resume(id, "continue", undefined, { isBackground: true });
    await manager.getRecord(id)!.promise;

    expect(resumeAgent).toHaveBeenCalledTimes(2);
    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      status: "completed",
      result: "recovered",
    }));
  });

  it.each([
    // 進捗の2経路: ツール実行（toolUses）とターン追加（session.messages）。
    "tool activity",
    "session messages",
  ])("resets the consecutive-failure budget when progress happens mid-retry (%s)", async (progressKind) => {
    projectDir = configureRetry({ enabled: true, maxAttempts: 3, baseDelayMs: 0 });
    const session = mockSession();
    // messages 経路用: 再送のたびに1ターン分増えるセッション。
    session.messages = [];
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return { responseText: "first run done", session, aborted: false, steered: false };
    });
    // 初回 resume は切断。以降の再送は進捗を残しつつ切断し続け、5回目に成功する。
    // 進捗リセットが無ければ maxAttempts: 3（再送2回）で打ち切られ error になる。
    let resumeCalls = 0;
    vi.mocked(resumeAgent).mockImplementation(async (_session: unknown, _prompt: string, opts: any) => {
      resumeCalls++;
      if (resumeCalls >= 5) return { text: "recovered" };
      if (progressKind === "tool activity") opts.onToolActivity?.({ type: "end" });
      // 実機と同じく user メッセージも push されるが、進捗として数えるのは
      // stopReason が error でない成功 assistant ターンのみ。
      else session.messages.push({ role: "user", content: "retry" }, { role: "assistant", content: [], stopReason: "stop" });
      return { text: "", failure: "stream disconnected before completion" };
    });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "kick off", {
      description: "progress resets budget",
    });
    await manager.getRecord(id)!.promise;

    const record = await manager.resume(id, "continue");

    // 初回 resume + 再送4回 = resumeAgent 5回。maxAttempts: 3 を超えて完走する。
    expect(resumeAgent).toHaveBeenCalledTimes(5);
    expect(record).toEqual(expect.objectContaining({
      status: "completed",
      result: "recovered",
    }));
  });

  it("still stops at maxAttempts on the resume route when the conversation never advances", async () => {
    // 進捗ゼロの連続故障は予算を開けない（無限ループしない）ことの証拠。
    projectDir = configureRetry({ enabled: true, maxAttempts: 3, baseDelayMs: 0 });
    const session = mockSession();
    // 実機の Pi と同じ: 失敗した resumeAgent 呼び出しも再送プロンプト（user）と
    // エラー応答（assistant, stopReason: "error"）を messages に push する。
    // 素の messages.length で進捗判定すると毎回 true になり、予算がリセット
    // されて無限ループする（BLOCKER 回帰テスト）。
    session.messages = [];
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return { responseText: "first run done", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockImplementation(async () => {
      session.messages.push(
        { role: "user", content: "retry" },
        { role: "assistant", content: [], stopReason: "error", errorMessage: "stream disconnected" },
      );
      return { text: "", failure: "stream disconnected before completion" };
    });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "kick off", {
      description: "no progress stops at budget",
    });
    await manager.getRecord(id)!.promise;

    const record = await manager.resume(id, "continue");

    // エラー応答の push は進捗とみなされず、初回 resume + 再送2回
    // （maxAttempts: 3）= 3回で打ち切り。
    expect(resumeAgent).toHaveBeenCalledTimes(3);
    expect(record).toEqual(expect.objectContaining({
      status: "error",
      error: "stream disconnected before completion",
    }));
  });

  it("caps progress-based resets so an endlessly-advancing agent still terminates", async () => {
    // 毎回ツール実行で「進捗」しつつ切断し続ける経路でも、リセット上限
    // （MAX_PROGRESS_RESETS = 10）で確実に停止する（無限ループしない）。
    projectDir = configureRetry({ enabled: true, maxAttempts: 3, baseDelayMs: 0 });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return { responseText: "first run done", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockImplementation(async (_session: unknown, _prompt: string, opts: any) => {
      opts.onToolActivity?.({ type: "end" });
      return { text: "", failure: "stream disconnected before completion" };
    });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, { cwd: projectDir } as any, "general-purpose", "kick off", {
      description: "progress cap",
    });
    await manager.getRecord(id)!.promise;

    const record = await manager.resume(id, "continue");

    // 初回 resume 1回 + 進捗リセット10回 + 上限到達後の予算2回 = 13回で停止。
    expect(resumeAgent).toHaveBeenCalledTimes(13);
    expect(record).toEqual(expect.objectContaining({
      status: "error",
      error: "stream disconnected before completion",
    }));
  });
});

describe("classifyRetryFailureFamily", () => {
  it("prioritizes usage-limit over stream/transient wording", () => {
    expect(classifyRetryFailureFamily("status 429: stream disconnected")).toBe("usage-limit");
    expect(classifyRetryFailureFamily(new Error("rate limit exceeded: socket hang up"))).toBe("usage-limit");
  });

  it("classifies stream, transient, and non-retryable failures", () => {
    expect(classifyRetryFailureFamily("stream disconnected before completion")).toBe("stream");
    expect(classifyRetryFailureFamily("socket hang up")).toBe("stream");
    expect(classifyRetryFailureFamily("fetch failed")).toBe("transient");
    expect(classifyRetryFailureFamily(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe("transient");
    expect(classifyRetryFailureFamily(new Error("The operation was aborted"))).toBe("transient");
    expect(classifyRetryFailureFamily("authentication failed")).toBe("none");
  });

  it("finds retryable text inside a cause chain", () => {
    const wrapped = new Error("upstream wrapper") as Error & { cause?: unknown };
    wrapped.cause = new Error("fetch failed");
    expect(classifyRetryFailureFamily(wrapped)).toBe("transient");
  });
});
