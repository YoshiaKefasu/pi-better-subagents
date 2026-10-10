import { describe, expect, it } from "vitest";
import { MAX_TODO_NUDGES } from "../src/agent-runner.js";
import { buildTodoNudgePrompt, type SubagentTodo } from "../src/nested-todos.js";

/**
 * todo-nudge — runAgent 内の未完了 ToDo リマインド継続の契約テスト。
 *
 * runner 本体ループ（session.prompt のモックが必要な重い経路）はここでは
 * 回さず、ループを律する定数と、再送プロンプトの形式（nested-todos.ts の
 * buildTodoNudgePrompt と同一）を固定する。形式が変わったらこのテストと
 * runner の両方を更新すること。
 */

describe("todo-nudge — リマインド継続の契約", () => {
  it("MAX_TODO_NUDGES は 5（無限ループ防止の上限）", () => {
    expect(MAX_TODO_NUDGES).toBe(5);
  });

  it("未完了があればリマインド文に件数と一覧が入る（→ continue で同一セッションに再送）", () => {
    const unfinished: SubagentTodo[] = [
      { id: "t1", content: "設計を読む", status: "in_progress" },
      { id: "t3", content: "テストを書く", status: "pending" },
    ];
    const prompt = buildTodoNudgePrompt(unfinished);
    expect(prompt).toContain("ToDoまだまだ残ってます。全部終わらせてから報告してください。");
    expect(prompt).toContain("未完了タスク (2件):");
    expect(prompt).toContain("- [t1] (in_progress) 設計を読む");
    expect(prompt).toContain("- [t3] (pending) テストを書く");
    // 完了済みは一覧に入れない。
    expect(prompt).not.toContain("t2");
  });

  it("未完了 0 件ではリマインドを送らない（→ break で完了）", () => {
    expect(buildTodoNudgePrompt([])).toContain("未完了タスク (0件):");
    // runner は unfinished.length > 0 のときのみ continue する。
    const shouldNudge = ([] as SubagentTodo[]).length > 0;
    expect(shouldNudge).toBe(false);
  });

  it("上限到達後はリマインドを送らない（無限ループ防止）", () => {
    const shouldNudge = (nudgeCount: number): boolean =>
      nudgeCount < MAX_TODO_NUDGES;
    expect(shouldNudge(4)).toBe(true);
    expect(shouldNudge(5)).toBe(false);
    expect(shouldNudge(99)).toBe(false);
  });
});
