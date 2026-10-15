/**
 * ask-user.test.ts — `ask_user`（サブエージェント → 親セッションへの質問・回答待機）の契約テスト。
 *
 * Part A: ツールと待機状態マシン（fake manager、nested-todos.test.ts と同じ手触り）。
 * Part B: agent-runner の実ループ（session をモック）で、事故当初のシナリオ —
 *   「未完了 ToDo を残したまま質問した子が ToDo リマインドで急かされず、
 *     親の回答を次ターンのプロンプトとして再開する」
 *   を検証する。ここのループは nested-todos の実ストアと ask-user の実状態を使う。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASK_USER_TOOL_NAME,
  clearAskUserWaiting,
  createAskUserTool,
  deliverAskUserAnswer,
  isAskUserWaiting,
  peekAskUserQuestion,
  waitForAskUserAnswer,
} from "../src/ask-user.js";
import { dropNestedTodos } from "../src/nested-todos.js";

// ─── Part A: tool + waiting machinery (fake manager) ───────────────────────

interface FakeRecord {
  id: string;
  handle?: string;
  status: string;
}

function makeFakeManager() {
  const records = new Map<string, FakeRecord>();
  return {
    records,
    getRecord: (id: string): FakeRecord | undefined => records.get(id),
  };
}

type FakeManager = ReturnType<typeof makeFakeManager>;

/** ask_user を使ったテストのキー（後片付け用）。 */
const trackedKeys: string[] = [];

afterEach(() => {
  for (const key of trackedKeys.splice(0)) {
    clearAskUserWaiting(key);
    dropNestedTodos(key);
  }
});

/** サブエージェントのふりをする: レコードを用意し、その所有者としてツールを1つ作る。 */
function subagent(manager: FakeManager, id: string, handle?: string) {
  manager.records.set(id, { id, handle, status: "running" });
  const key = handle ?? id;
  trackedKeys.push(key);
  const questions: string[] = [];
  const tool = createAskUserTool({
    manager,
    parentAgentId: id,
    onQuestion: (question) => questions.push(question),
  });
  expect(tool.name).toBe(ASK_USER_TOOL_NAME);
  return { tool, questions, key };
}

async function exec(tool: ReturnType<typeof createAskUserTool>, params: Record<string, unknown>) {
  return tool.execute("call-1", params as never, undefined, undefined, {} as never);
}

function textOf(result: Awaited<ReturnType<typeof exec>>): string {
  const first = (result.content as { type: string; text: string }[])[0];
  return first?.text ?? "";
}

describe("ask_user — tool behavior", () => {
  it("質問が onQuestion で通知され、待機状態に入る", async () => {
    const manager = makeFakeManager();
    const { tool, questions, key } = subagent(manager, "a-1");

    const result = await exec(tool, { question: "A案とB案、どちらにしますか？" });

    expect(result.isError).toBe(false);
    expect(questions).toEqual(["A案とB案、どちらにしますか？"]);
    expect(isAskUserWaiting(key)).toBe(true);
    expect(peekAskUserQuestion(key)).toBe("A案とB案、どちらにしますか？");
    // 戻り値は「待機して答えを待て」という契約。
    expect(textOf(result)).toContain("質問を親セッションに送信しました");
    expect(textOf(result)).toContain("回答が届くまで独断での作業やツールの実行は行わないでください");
  });

  it("onQuestion が無くても待機状態には入る（通知だけ欠ける）", async () => {
    const manager = makeFakeManager();
    manager.records.set("a-1b", { id: "a-1b", status: "running" });
    trackedKeys.push("a-1b");
    const tool = createAskUserTool({ manager, parentAgentId: "a-1b" });

    const result = await exec(tool, { question: "確認です" });

    expect(result.isError).toBe(false);
    expect(isAskUserWaiting("a-1b")).toBe(true);
  });

  it("空白だけの question は拒否する（待機状態にならない）", async () => {
    const manager = makeFakeManager();
    const { tool, questions, key } = subagent(manager, "a-2");

    const result = await exec(tool, { question: "   " });

    expect(result.isError).toBe(true);
    expect(questions).toEqual([]);
    expect(isAskUserWaiting(key)).toBe(false);
  });

  it("メインからの呼び出しは拒否する: レコードの無い parentAgentId", async () => {
    const manager = makeFakeManager();
    const tool = createAskUserTool({ manager, parentAgentId: "main-session" });

    const result = await exec(tool, { question: "よろしいですか？" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("only available inside a subagent session");
    expect(isAskUserWaiting("main-session")).toBe(false);
  });

  it("保持キーは handle ?? id（nested-todos と共通）", async () => {
    const manager = makeFakeManager();
    const { tool, key } = subagent(manager, "old-id", "explore");
    await exec(tool, { question: "どっち？" });

    expect(key).toBe("explore");
    expect(isAskUserWaiting("explore")).toBe(true);
    expect(peekAskUserQuestion("explore")).toBe("どっち？");
  });

  it("再質問では同じキーの待機を保ったまま質問文を更新する", async () => {
    const manager = makeFakeManager();
    const { tool, key } = subagent(manager, "a-3");
    await exec(tool, { question: "最初の質問" });
    await exec(tool, { question: "言い直した質問" });

    expect(peekAskUserQuestion(key)).toBe("言い直した質問");
    expect(isAskUserWaiting(key)).toBe(true);
  });
});

describe("ask_user — 回答の配送（wait/deliver）", () => {
  it("deliverAskUserAnswer で待機 Promise が解決する", async () => {
    const manager = makeFakeManager();
    const { tool, key } = subagent(manager, "a-4");
    await exec(tool, { question: "どっち？" });

    const waiting = waitForAskUserAnswer(key);
    expect(deliverAskUserAnswer(key, "B案で")).toBe(true);
    expect(await waiting).toBe("B案で");
    // 回答の消費で待機状態は解除される（次の質問は新エントリ）。
    expect(isAskUserWaiting(key)).toBe(false);
  });

  it("waiter 前に届いた回答は buffer され、wait で即解決する", async () => {
    // runner の isAskUserWaiting チェックと waitForAskUserAnswer の間に
    // steer_subagent が到達した場合のrace保護。
    const manager = makeFakeManager();
    const { tool, key } = subagent(manager, "a-5");
    await exec(tool, { question: "どっち？" });

    expect(deliverAskUserAnswer(key, "先に届いた回答")).toBe(true);
    expect(isAskUserWaiting(key)).toBe(true); // 未消費なので待機状態のまま
    expect(await waitForAskUserAnswer(key)).toBe("先に届いた回答");
    expect(isAskUserWaiting(key)).toBe(false);
  });

  it("質問していないキーへの deliver は false", () => {
    expect(deliverAskUserAnswer("no-such-key", "answer")).toBe(false);
  });

  it("質問前に waitForAskUserAnswer を呼ぶと reject する", async () => {
    await expect(waitForAskUserAnswer("never-asked")).rejects.toThrow(/No pending ask_user question/);
  });

  it("消費済みのキーへの2回目の deliver は false", async () => {
    const manager = makeFakeManager();
    const { tool, key } = subagent(manager, "a-6");
    await exec(tool, { question: "どっち？" });

    const waiting = waitForAskUserAnswer(key);
    expect(deliverAskUserAnswer(key, "1回目の回答")).toBe(true);
    expect(await waiting).toBe("1回目の回答");
    expect(deliverAskUserAnswer(key, "2回目の回答")).toBe(false);
  });

  it("連続した質問→回答→質問→回答 が往復する", async () => {
    const manager = makeFakeManager();
    const { tool, key } = subagent(manager, "a-7");

    await exec(tool, { question: "1問目" });
    expect(deliverAskUserAnswer(key, "回答1")).toBe(true);
    expect(await waitForAskUserAnswer(key)).toBe("回答1");

    await exec(tool, { question: "2問目" });
    expect(isAskUserWaiting(key)).toBe(true);
    const waiting = waitForAskUserAnswer(key);
    expect(deliverAskUserAnswer(key, "回答2")).toBe(true);
    expect(await waiting).toBe("回答2");
  });

  it("二重 wait は旧 Promise を reject し、新しい待機が生き残る", async () => {
    // supersede 後、旧 waiter の reject が entry を Map から落とさないこと。
    // 落ちると isAskUserWaiting が false になり steer_subagent が答えを
    // 通常 steer に流してしまい、質問が回答されない。
    const manager = makeFakeManager();
    const { tool, key } = subagent(manager, "a-13");
    await exec(tool, { question: "どっち？" });

    const first = waitForAskUserAnswer(key);
    const second = waitForAskUserAnswer(key);
    await expect(first).rejects.toThrow(/superseded/);

    expect(isAskUserWaiting(key)).toBe(true);
    expect(deliverAskUserAnswer(key, "新しい方へ")).toBe(true);
    expect(await second).toBe("新しい方へ");
    expect(isAskUserWaiting(key)).toBe(false);
  });
});

describe("ask_user — 中断と解除", () => {
  it("AbortSignal 発火で待機がクリーンに reject され、待機状態も解除される", async () => {
    const manager = makeFakeManager();
    const { tool, key } = subagent(manager, "a-8");
    await exec(tool, { question: "どっち？" });

    const controller = new AbortController();
    const waiting = waitForAskUserAnswer(key, controller.signal);
    controller.abort();

    await expect(waiting).rejects.toThrow(/aborted/);
    expect(isAskUserWaiting(key)).toBe(false);
  });

  it("abort 済みの signal を渡した待機は即 reject する", async () => {
    const manager = makeFakeManager();
    const { tool, key } = subagent(manager, "a-9");
    await exec(tool, { question: "どっち？" });

    const controller = new AbortController();
    controller.abort();

    await expect(waitForAskUserAnswer(key, controller.signal)).rejects.toThrow(/aborted/);
    expect(isAskUserWaiting(key)).toBe(false);
  });

  it("clearAskUserWaiting は待機 Promise を reject して解除する（GC 経路）", async () => {
    const manager = makeFakeManager();
    const { tool, key } = subagent(manager, "a-10");
    await exec(tool, { question: "どっち？" });

    const waiting = waitForAskUserAnswer(key);
    clearAskUserWaiting(key);

    await expect(waiting).rejects.toThrow(/cleared/);
    expect(isAskUserWaiting(key)).toBe(false);
    // 解除後の deliver は false（呼び出し元は通常 steer にフォールバックできる）。
    expect(deliverAskUserAnswer(key, "遅すぎた回答")).toBe(false);
  });

  it("clearAskUserWaiting は違うキーに影響しない", async () => {
    const manager = makeFakeManager();
    const one = subagent(manager, "a-11");
    const two = subagent(manager, "a-12");
    await exec(one.tool, { question: "1" });
    await exec(two.tool, { question: "2" });

    clearAskUserWaiting(one.key);

    expect(isAskUserWaiting(one.key)).toBe(false);
    expect(isAskUserWaiting(two.key)).toBe(true);
  });
});

// ─── Part B: runner loop (mocked session, real nested-todos / ask-user) ────

const { createAgentSession } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  // Identity, as pi's own is: `defineTool` exists for the type inference, and
  // the ask_user tool is built through it.
  defineTool: (definition: unknown) => definition,
  DefaultResourceLoader: class {
    opts: any;
    constructor(options: any) {
      this.opts = options;
    }

    async reload() {}
    getExtensions() {
      return { extensions: [], errors: [], runtime: {} };
    }
  },
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  SessionManager: {
    inMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
    create: vi.fn(() => ({ kind: "persistent-session-manager" })),
    open: vi.fn(() => ({ kind: "reopened-session-manager" })),
  },
  SettingsManager: {
    create: vi.fn(() => ({ kind: "settings-manager", getSessionDir: () => undefined })),
  },
}));

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read"]),
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

vi.mock("../src/nested-tools.js", () => ({
  getMaxSubagentDepth: vi.fn(() => 2),
  createNestedSubagentTools: vi.fn(() => []),
}));

import { runAgent } from "../src/agent-runner.js";

type CustomTool = { name: string; execute: (id: string, params: unknown) => Promise<unknown> };

/** The customTools the runner injected into the mocked session. */
function injectedTools(): CustomTool[] {
  const opts = createAgentSession.mock.calls[0]?.[0];
  return (opts?.customTools ?? []) as CustomTool[];
}

const runnerCtx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: {
    getBranch: vi.fn(() => []),
    getSessionFile: vi.fn(() => "/sessions/parent.jsonl"),
  },
} as any;

/** 質問ラベルの解決元になる最小限のレコード。 */
const agentRecord = { id: "agent-1", type: "Explore", status: "running" } as any;

beforeEach(() => {
  createAgentSession.mockReset();
});

/** condition が真になるまで yield しながら待つ（runAgent の起動直後の非同期を吸収）。 */
async function waitFor(condition: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was never met");
}

/**
 * セッションのモック。`behave` が1ターンの振る舞いを演じる:
 * ターン中に注入済みの customTools（ask_user / subagent_todo）を直接実行して、
 * エージェントがツールを呼んだ状況を再現する。
 */
function makeSession(behave: (prompt: string) => Promise<void>) {
  const messages: any[] = [];
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages,
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async (text: string) => {
      await behave(text);
      // pi emits turn_end after each turn — the runner's turn counting and the
      // soft max_turns limit hang off it.
      for (const listener of listeners) listener({ type: "turn_end" });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    getAllTools: vi.fn(() => []),
    agent: {},
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return session;
}

describe("ask_user — agent-runner loop integration", () => {
  it("ask_user 中は ToDo リマインドを抑止し、回答を次ターンのプロンプトとして再開する", async () => {
    const prompts: string[] = [];
    let asked = false;
    const session = makeSession(async (prompt) => {
      prompts.push(prompt);
      if (!asked) {
        asked = true;
        // 事故当初のシナリオ: 子が ask_user で質問し、未完了 ToDo を残してターンを終える。
        await injectedTools().find((t) => t.name === "ask_user")!.execute("tc-ask", {
          question: "A案とB案、どちらにしますか？",
        });
        await injectedTools().find((t) => t.name === "subagent_todo")!.execute("tc-todo", {
          op: "set",
          todos: [{ content: "実装する" }],
        });
      } else {
        // 回答を受け取った2ターン目: ToDo を完了させて報告する。
        await injectedTools().find((t) => t.name === "subagent_todo")!.execute("tc-todo2", {
          op: "update",
          todo: { id: "t1", status: "completed" },
        });
      }
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "final report" }] });
    });
    createAgentSession.mockResolvedValue({ session });
    const sendMessage = vi.fn();
    const pi = { sendMessage } as any;

    const runPromise = runAgent(runnerCtx, "Explore", "タスクを実行して", {
      pi,
      nestedRuntime: { manager: { getRecord: () => agentRecord } as any, parentAgentId: "agent-1", depth: 1 },
    });

    // 1ターン目が終わり、質問待機に入る。
    await waitFor(() => isAskUserWaiting("agent-1"));

    // 親セッションへリアルタイム通知（steer 割り込みでターンを起こす）。
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        display: true,
        content: expect.stringContaining("A案とB案、どちらにしますか？"),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );
    expect(sendMessage.mock.calls[0][0].content).toContain('steer_subagent(agent_id: "agent-1"');

    // 未完了 ToDo があるのに、リマインドは送られていない（ここが本題）。
    expect(prompts).toEqual(["タスクを実行して"]);
    expect(prompts.some((p) => p.includes("ToDoまだまだ残ってます"))).toBe(false);

    // steer_subagent 経由の回答で再開。
    expect(deliverAskUserAnswer("agent-1", "B案でお願いします")).toBe(true);
    const result = await runPromise;

    // 回答が次のターンのプロンプトとして実行され、リマインドは最終的に来ない。
    expect(prompts).toEqual(["タスクを実行して", "B案でお願いします"]);
    expect(prompts.some((p) => p.includes("ToDoまだまだ残ってます"))).toBe(false);
    // 待機の解除は session.steer ではない（割り込む先のツール実行が無いため）。
    expect(session.steer).not.toHaveBeenCalled();
    expect(result.responseText).toContain("final report");
    expect(result.failure).toBeUndefined();
    expect(isAskUserWaiting("agent-1")).toBe(false);
  });

  it("孫エージェント（depth 2）には ask_user を注入しない", async () => {
    // depth ≥ 2 は親エージェントに自律的に結果を返す契約。親はツール実行中で
    // 回答できず、ask_user があると実行が永久に park する。
    const session = makeSession(async () => {
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    });
    createAgentSession.mockResolvedValue({ session });

    await runAgent(runnerCtx, "Explore", "go", {
      pi: { sendMessage: vi.fn() } as any,
      nestedRuntime: { manager: { getRecord: () => agentRecord } as any, parentAgentId: "agent-1", depth: 2 },
    });

    // ToDo は注入されるが、ask_user は depth 1 専用。
    expect(injectedTools().map((t) => t.name)).toEqual(["subagent_todo"]);
  });

  it("soft limit 到達で質問待機が飛ばされたら finally が待機を掃除する", async () => {
    // max_turns に達すると待機ゲート（!softLimitReached）もナッジも飛ばされて
    // break する。このとき待機エントリが残ると GC までリークする。
    const prompts: string[] = [];
    const session = makeSession(async (prompt) => {
      prompts.push(prompt);
      await injectedTools().find((t) => t.name === "ask_user")!.execute("tc-ask", {
        question: "まだ続けますか？",
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "asked and parked" }] });
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(runnerCtx, "Explore", "タスクを実行して", {
      pi: { sendMessage: vi.fn() } as any,
      maxTurns: 1,
      nestedRuntime: { manager: { getRecord: () => agentRecord } as any, parentAgentId: "agent-1", depth: 1 },
    });

    // ゲートを飛ばして break → finally の clearAskUserWaiting で待機が消える。
    expect(isAskUserWaiting("agent-1")).toBe(false);
    expect(prompts).toEqual(["タスクを実行して"]);
    expect(result.steered).toBe(true);
    // soft limit の steer は飛んでいる（wrap up 指示）。
    expect(session.steer).toHaveBeenCalled();
  });

  it("待機中に AbortSignal が発火したらクリーンに終了する（nudge も回答も無し）", async () => {
    const prompts: string[] = [];
    const session = makeSession(async (prompt) => {
      prompts.push(prompt);
      await injectedTools().find((t) => t.name === "ask_user")!.execute("tc-ask", {
        question: "止められる？",
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "asked and parked" }] });
    });
    createAgentSession.mockResolvedValue({ session });
    const controller = new AbortController();

    const runPromise = runAgent(runnerCtx, "Explore", "タスクを実行して", {
      pi: { sendMessage: vi.fn() } as any,
      signal: controller.signal,
      nestedRuntime: { manager: { getRecord: () => agentRecord } as any, parentAgentId: "agent-1", depth: 1 },
    });

    await waitFor(() => isAskUserWaiting("agent-1"));
    controller.abort();

    // reject は飲み込まれ、runAgent は通常どおり resolve する。
    const result = await runPromise;

    expect(isAskUserWaiting("agent-1")).toBe(false);
    expect(prompts).toEqual(["タスクを実行して"]);
    expect(prompts.some((p) => p.includes("ToDoまだまだ残ってます"))).toBe(false);
    expect(session.abort).toHaveBeenCalled();
    expect(result.responseText).toContain("asked and parked");
  });
});
