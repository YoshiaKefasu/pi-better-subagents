import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import {
  createNestedTodoTool,
  dropNestedTodos,
  getUnfinishedTodos,
  NESTED_TODO_TOOL_NAME,
  peekNestedTodos,
  resolveNestedTodoKey,
} from "../src/nested-todos.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";

// ---- fake-manager unit tests (tool behavior) ----

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

const trackedKeys: string[] = [];

afterEach(() => {
  for (const key of trackedKeys.splice(0)) dropNestedTodos(key);
});

/** Subagent のふりをする: レコードを用意し、その所有者としてツールを1つ作る。 */
function subagent(manager: FakeManager, id: string, handle?: string) {
  manager.records.set(id, { id, handle, status: "running" });
  const key = handle ?? id;
  trackedKeys.push(key);
  const tool = createNestedTodoTool({ manager, parentAgentId: id });
  expect(tool.name).toBe(NESTED_TODO_TOOL_NAME);
  return tool;
}

async function exec(tool: ReturnType<typeof createNestedTodoTool>, params: Record<string, unknown>) {
  return tool.execute("call-1", params as never, undefined, undefined, {} as never);
}

function textOf(result: Awaited<ReturnType<typeof exec>>): string {
  const first = (result.content as { type: string; text: string }[])[0];
  return first?.text ?? "";
}

describe("subagent_todo — tool behavior", () => {
  it("set → list が往復し、ID はエージェント内で一意に採番される", async () => {
    const manager = makeFakeManager();
    const tool = subagent(manager, "a-1");

    const setResult = await exec(tool, {
      op: "set",
      todos: [{ content: "設計を読む" }, { content: "実装する", priority: "high" }],
    });
    expect(setResult.isError).toBe(false);
    expect(textOf(setResult)).toContain("(t1)");
    expect(textOf(setResult)).toContain("(t2)");

    const listResult = await exec(tool, { op: "list" });
    expect(listResult.isError).toBe(false);
    const text = textOf(listResult);
    expect(text).toContain("[ ] (t1) 設計を読む");
    expect(text).toContain("[ ] (t2) 実装する [high]");
  });

  it("update で pending → in_progress → completed に遷移できる", async () => {
    const manager = makeFakeManager();
    const tool = subagent(manager, "a-2");
    await exec(tool, { op: "set", todos: [{ content: "やる" }] });

    await exec(tool, { todo: { id: "t1", status: "in_progress" }, op: "update" });
    let text = textOf(await exec(tool, { op: "list" }));
    expect(text).toContain("[~] (t1)");

    const done = await exec(tool, { todo: { id: "t1", status: "completed" }, op: "update" });
    expect(done.isError).toBe(false);
    text = textOf(await exec(tool, { op: "list" }));
    expect(text).toContain("[x] (t1)");
  });

  it("update は content / priority も変えられる。空更新・未知IDは拒否する", async () => {
    const manager = makeFakeManager();
    const tool = subagent(manager, "a-3");
    await exec(tool, { op: "set", todos: [{ content: "やる" }] });

    const renamed = await exec(tool, {
      op: "update",
      todo: { id: "t1", content: "やり直す", priority: "low" },
    });
    expect(renamed.isError).toBe(false);
    expect(textOf(await exec(tool, { op: "list" }))).toContain("(t1) やり直す [low]");

    expect((await exec(tool, { op: "update", todo: { id: "t1" } })).isError).toBe(true);
    expect((await exec(tool, { op: "update", todo: { id: "t9", status: "completed" } })).isError).toBe(true);
  });

  it("set のバリデーション: todos 必須・content 非空・status 既知", async () => {
    const manager = makeFakeManager();
    const tool = subagent(manager, "a-4");

    expect((await exec(tool, { op: "set" })).isError).toBe(true);
    expect((await exec(tool, { op: "set", todos: [] })).isError).toBe(true);
    expect((await exec(tool, { op: "set", todos: [{ content: "  " }] })).isError).toBe(true);
    expect(
      (await exec(tool, { op: "set", todos: [{ content: "x", status: "doing" }] })).isError,
    ).toBe(true);
    // 失敗してもリストは空のまま。
    expect(textOf(await exec(tool, { op: "list" }))).toContain("No todos");
  });

  it("clear は全件破棄し、ID 採番は再利用しない", async () => {
    const manager = makeFakeManager();
    const tool = subagent(manager, "a-5");
    await exec(tool, { op: "set", todos: [{ content: "やる" }] });

    const cleared = await exec(tool, { op: "clear" });
    expect(cleared.isError).toBe(false);
    expect(textOf(await exec(tool, { op: "list" }))).toContain("No todos");

    const again = await exec(tool, { op: "set", todos: [{ content: "次" }] });
    expect(textOf(again)).toContain("(t2)");
  });

  it("分離性: A のリストは B から見えない・触れない", async () => {
    const manager = makeFakeManager();
    const toolA = subagent(manager, "agent-a");
    const toolB = subagent(manager, "agent-b");
    await exec(toolA, { op: "set", todos: [{ content: "Aの仕事" }, { content: "Aの仕事2" }] });

    expect(textOf(await exec(toolB, { op: "list" }))).toContain("No todos");
    // B が A の ID を知っていても（t1 は推測可能）、B の名前空間には存在しない。
    expect((await exec(toolB, { op: "update", todo: { id: "t1", status: "completed" } })).isError).toBe(true);
    // A は無傷。
    expect(textOf(await exec(toolA, { op: "list" }))).toContain("Todos (2)");
  });

  it("メインからの呼び出しは拒否する: レコードの無い parentAgentId", async () => {
    const manager = makeFakeManager();
    const tool = createNestedTodoTool({ manager, parentAgentId: "main-session" });

    for (const params of [
      { op: "list" },
      { op: "set", todos: [{ content: "x" }] },
      { op: "update", todo: { id: "t1", status: "completed" } },
      { op: "clear" },
    ]) {
      const result = await exec(tool, params);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("only available inside a subagent session");
    }
  });

  it("保持キーは handle ?? id（tombstone と同一キー）", () => {
    expect(resolveNestedTodoKey({ id: "abc" })).toBe("abc");
    expect(resolveNestedTodoKey({ id: "abc", handle: "explore" })).toBe("explore");
  });

  it("同一 handle（tombstone 経由 resume の新 ID）では ToDo を引き継ぐ", async () => {
    const manager = makeFakeManager();
    // 旧レコードで作った ToDo を、新 ID・同一 handle のレコードから読める。
    const before = subagent(manager, "old-id", "explore");
    await exec(before, { op: "set", todos: [{ content: "引き継ぐ仕事" }] });

    const after = subagent(manager, "new-id", "explore");
    expect(textOf(await exec(after, { op: "list" }))).toContain("引き継ぐ仕事");
  });

  it("stop → 同ID resume では ToDo が残る（レコードが消えないため）", async () => {
    const manager = makeFakeManager();
    const tool = subagent(manager, "a-6");
    await exec(tool, { op: "set", todos: [{ content: "止まっても残る" }] });

    manager.records.get("a-6")!.status = "stopped";
    expect(textOf(await exec(tool, { op: "list" }))).toContain("止まっても残る");

    manager.records.get("a-6")!.status = "running";
    expect(textOf(await exec(tool, { op: "list" }))).toContain("止まっても残る");
  });

  it("dropNestedTodos は指定キーのみ破棄する", async () => {
    const manager = makeFakeManager();
    const toolA = subagent(manager, "agent-c");
    const toolB = subagent(manager, "agent-d");
    await exec(toolA, { op: "set", todos: [{ content: "C" }] });
    await exec(toolB, { op: "set", todos: [{ content: "D" }] });

    dropNestedTodos("agent-c");
    expect(peekNestedTodos("agent-c")).toEqual([]);
    expect(peekNestedTodos("agent-d")).toHaveLength(1);
  });
});

// ---- real-manager lifecycle tests (purge wiring) ----

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const TEN_MINUTES = 10 * 60_000;
/** agent-manager のレコード保持期間。GC はこの後に初めてレコードを落とす。 */
const RECORD_RETAIN_MS = 24 * 60 * 60_000;

describe("subagent_todo — lifecycle with AgentManager", () => {
  let manager: AgentManager | undefined;

  afterEach(async () => {
    await manager?.dispose();
    manager = undefined;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function settledNested(prompt: string): Promise<{ id: string }> {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", prompt, {
      description: prompt,
      isBackground: true,
      parentAgentId: "parent-1",
    });
    await manager.getRecord(id)!.promise;
    return { id };
  }

  function todoToolFor(id: string) {
    return createNestedTodoTool({ manager: manager!, parentAgentId: id });
  }

  async function execOn(id: string, params: Record<string, unknown>) {
    return todoToolFor(id).execute("call-1", params as never, undefined, undefined, {} as never);
  }

  it("stop → resume（実 resume 呼び出し）で ToDo が残る", async () => {
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as any);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "again", failure: undefined } as any);
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "work", {
      description: "work",
      isBackground: true,
      parentAgentId: "parent-1",
    });
    const record = manager.getRecord(id)!;
    trackedKeys.push(id);

    await execOn(id, { op: "set", todos: [{ content: "1件目" }, { content: "2件目" }] });

    // メインが Stop（abort）してもレコードは残る → ToDo も残る。
    expect(manager.abort(id)).toBe(true);
    expect(peekNestedTodos(id)).toHaveLength(2);

    // 同 ID で resume（同一レコードを使い回す）→ ToDo は引き継がれる。
    record.session = {} as any;
    await manager.resume(id, "continue");
    expect(manager.getRecord(id)?.id).toBe(id);
    expect(peekNestedTodos(id).map(t => t.content)).toEqual(["1件目", "2件目"]);
  });

  it("GC でレコードが消えた nested の ToDo は破棄される", async () => {
    vi.useFakeTimers();
    const { id } = await settledNested("stale");
    trackedKeys.push(id);
    await execOn(id, { op: "set", todos: [{ content: "消える仕事" }] });
    expect(peekNestedTodos(id)).toHaveLength(1);

    // 保持期間は 24 時間。10 分では live session が解放されるだけでレコードは
    // 残るので、ToDo もまだ生きている。
    manager!.getRecord(id)!.completedAt = Date.now() - (TEN_MINUTES + 30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager!.getRecord(id)).toBeDefined();
    expect(peekNestedTodos(id)).toHaveLength(1);

    manager!.getRecord(id)!.completedAt = Date.now() - (RECORD_RETAIN_MS + 30_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(manager!.getRecord(id)).toBeUndefined();
    expect(peekNestedTodos(id)).toEqual([]);
  });

  it("clearCompleted はレコードと共に ToDo を破棄し、生き残りには触らない", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    manager = new AgentManager();
    // 終了済みトップレベル: handle を持つので handle キーで ToDo が載る。
    const topId = manager.spawn(mockPi, mockCtx, "X", "top", { description: "top", isBackground: true });
    await manager.getRecord(topId)!.promise;
    const top = manager.getRecord(topId)!;
    top.sessionFile = "/tmp/session-top.md";
    const handle = top.handle!;
    trackedKeys.push(handle);
    await execOn(topId, { op: "set", todos: [{ content: "topの仕事" }] });
    expect(peekNestedTodos(handle)).toHaveLength(1);

    // 実行中の nested: 温存される。
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as any);
    const liveId = manager.spawn(mockPi, mockCtx, "X", "live", {
      description: "live",
      isBackground: true,
      parentAgentId: "parent-1",
    });
    trackedKeys.push(liveId);
    await execOn(liveId, { op: "set", todos: [{ content: "liveの仕事" }] });

    manager.clearCompleted();

    // セッション境界ではレコードごと ToDo も落ちる（会話は Disk に残るので
    // 復活手段は失われない）。生き残り（実行中）の ToDo には触らない。
    expect(manager.getRecord(topId)).toBeUndefined();
    expect(peekNestedTodos(handle)).toEqual([]);
    expect(peekNestedTodos(liveId)).toHaveLength(1);
  });

  it("レコードの破棄は対応する ToDo も破棄する", async () => {
    manager = new AgentManager();
    const fake = makeFakeManager();
    fake.records.set("gone-id", { id: "gone-id", handle: "gone", status: "stopped" });
    trackedKeys.push("gone");
    const tool = createNestedTodoTool({ manager: fake, parentAgentId: "gone-id" });
    await tool.execute("call-1", { op: "set", todos: [{ content: "x" }] } as never, undefined, undefined, {} as never);
    expect(peekNestedTodos("gone")).toHaveLength(1);

    // レコードが消える経路（GC / clearCompleted）は removeRecord 経由で
    // dropNestedTodos を呼ぶ。ここではその公開ヘルパーを直接撃って確認する。
    dropNestedTodos("gone");
    expect(peekNestedTodos("gone")).toEqual([]);
  });
});

describe("getUnfinishedTodos — 未完了検知（runner のリマインド継続用）", () => {
  it("pending / in_progress だけ返し、completed を除外する", async () => {
    const manager = makeFakeManager();
    const tool = subagent(manager, "unf-1");
    await exec(tool, { op: "set", todos: [{ content: "a" }, { content: "b" }, { content: "c" }] });
    await exec(tool, { op: "update", todo: { id: "t1", status: "in_progress" } });
    await exec(tool, { op: "update", todo: { id: "t2", status: "completed" } });

    const unfinished = getUnfinishedTodos("unf-1");
    expect(unfinished.map(t => t.id).sort()).toEqual(["t1", "t3"]);
    expect(unfinished.every(t => t.status !== "completed")).toBe(true);
  });

  it("全件 completed / 未作成キーでは空配列（→ runner は break）", async () => {
    const manager = makeFakeManager();
    const tool = subagent(manager, "unf-2");
    await exec(tool, { op: "set", todos: [{ content: "done" }] });
    await exec(tool, { op: "update", todo: { id: "t1", status: "completed" } });
    expect(getUnfinishedTodos("unf-2")).toEqual([]);
    expect(getUnfinishedTodos("no-such-key")).toEqual([]);
  });

  it("返却はコピー（変更してもストアに影響しない）", async () => {
    const manager = makeFakeManager();
    const tool = subagent(manager, "unf-3");
    await exec(tool, { op: "set", todos: [{ content: "x" }] });
    const first = getUnfinishedTodos("unf-3");
    first[0].status = "completed";
    first.push({ id: "tX", content: "fake", status: "pending" });
    expect(getUnfinishedTodos("unf-3")).toHaveLength(1);
  });
});
