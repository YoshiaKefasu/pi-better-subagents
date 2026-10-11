import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * nested-todos.ts — サブエージェント専用のToDoリスト。
 *
 * メインセッションには登録しない。agent-runner.ts が nested セッション
 * （`options.nestedRuntime` がある場合）のみに customTools として注入する。
 *
 * 保持キー: `handle ?? id`。
 * レコードが生きている間（実行中・完了後 24 時間の保持期間中含む）ToDo は残る。
 * 破棄は (a) op=clear の明示クリア、(b) レコード破棄時（GC・セッション切替）
 * に agent-manager.ts の removeRecord から dropNestedTodos() が呼ばれる経路、
 * のみ。永続化はしない（メモリ内のみ）。
 */

/** nested セッションにだけ公開するツール名。NESTED_TOOL_NAMES ともメインの SUBAGENT_TOOL_NAMES とも衝突しない。 */
export const NESTED_TODO_TOOL_NAME = "subagent_todo";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_PRIORITIES = ["low", "medium", "high"] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

export interface SubagentTodo {
  id: string;
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
}

interface AgentTodoState {
  items: SubagentTodo[];
  /** エージェント内で一意なID採番用カウンタ。単調増加し、再利用しない。 */
  seq: number;
}

/** エージェント単位の ToDo ストア。キー = handle ?? id。 */
const todoStores = new Map<string, AgentTodoState>();

/** 最小限のレコード像。実 AgentManager もこの構造的部分型として受け付ける。 */
export interface NestedTodoRecord {
  handle?: string;
  id: string;
}

export interface NestedTodoManager {
  getRecord(id: string): NestedTodoRecord | undefined;
}

export interface NestedTodoContext {
  manager: NestedTodoManager;
  /** 呼び出し元エージェント（このツールセットを注入された nested セッションの所有者）。 */
  parentAgentId: string;
}

/**
 * ToDo の保持キーを解決する。handle があるレコードは handle（disk reopen で
 * reclaim されるため、resume 後も同じキーに戻る）、ない nested レコードは
 * id（stop→同ID resume で引き継がれる）。
 */
export function resolveNestedTodoKey(record: NestedTodoRecord): string {
  return record.handle ?? record.id;
}

/** 指定キーの ToDo を破棄する。agent-manager.ts の破棄経路からのみ呼ぶ。 */
export function dropNestedTodos(key: string): void {
  todoStores.delete(key);
}

/** 指定キーの ToDo を読み取り専用コピーで返す（テスト・観測用）。 */
export function peekNestedTodos(key: string): SubagentTodo[] {
  return (todoStores.get(key)?.items ?? []).map(item => ({ ...item }));
}

/** 指定キーの未完了 ToDo（status !== "completed"）を読み取り専用コピーで返す。 */
export function getUnfinishedTodos(key: string): SubagentTodo[] {
  return peekNestedTodos(key).filter(item => item.status !== "completed");
}

/** 未完了 ToDo がある子エージェントへ送るリマインド文を組み立てる。runner とテストの共通仕様。 */
export function buildTodoNudgePrompt(unfinished: SubagentTodo[]): string {
  const list = unfinished.map(item => `- [${item.id}] (${item.status}) ${item.content}`).join("\n");
  return `ToDoまだまだ残ってます。全部終わらせてから報告してください。\n\n未完了タスク (${unfinished.length}件):\n${list}`;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

function renderTodos(items: SubagentTodo[]): string {
  if (items.length === 0) return "No todos. Use op \"set\" to create some.";
  const mark = (status: TodoStatus): string =>
    status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
  const lines = items.map(item =>
    `${mark(item.status)} (${item.id}) ${item.content}${item.priority ? ` [${item.priority}]` : ""}`,
  );
  return `Todos (${items.length}):\n${lines.join("\n")}`;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return TODO_STATUSES.includes(value as TodoStatus);
}

function isTodoPriority(value: unknown): value is TodoPriority {
  return TODO_PRIORITIES.includes(value as TodoPriority);
}

const TodoStatusSchema = Type.Union(
  TODO_STATUSES.map(status => Type.Literal(status)),
  { description: "Task status." },
);

const TodoPrioritySchema = Type.Union(
  TODO_PRIORITIES.map(priority => Type.Literal(priority)),
  { description: "Task priority." },
);

/** 自分自身の進捗管理用。親セッションの ToDo とは独立している。 */
export function createNestedTodoTool(context: NestedTodoContext): ToolDefinition {
  const tool = defineTool({
    name: NESTED_TODO_TOOL_NAME,
    label: "Subagent Todo",
    description:
      "Manage YOUR OWN progress todo list for multi-step work. " +
      "This list is private to you and independent of any parent todo list. " +
      "Ops: list (show), set (replace the whole list), update (change one item), clear (drop all). " +
      "Mark exactly one task in_progress at a time; mark completed as soon as it is done.",
    parameters: Type.Object({
      op: Type.Union(
        [Type.Literal("list"), Type.Literal("set"), Type.Literal("update"), Type.Literal("clear")],
        { description: "list: show the list. set: replace it wholesale. update: change one item. clear: drop everything." },
      ),
      todos: Type.Optional(Type.Array(
        Type.Object({
          content: Type.String({ minLength: 1, description: "Short imperative task description." }),
          status: Type.Optional(TodoStatusSchema),
          priority: Type.Optional(TodoPrioritySchema),
        }),
        { minItems: 1, description: "Full replacement list (op=set only)." },
      )),
      todo: Type.Optional(Type.Object({
        id: Type.String({ minLength: 1, description: "Todo id from op=list (e.g. t1)." }),
        content: Type.Optional(Type.String({ minLength: 1 })),
        status: Type.Optional(TodoStatusSchema),
        priority: Type.Optional(TodoPrioritySchema),
      }, { description: "Single-item change (op=update only)." })),
    }),
    execute: async (_toolCallId, params) => {
      // 呼び出し元特定: このツールは所有者セッション専用に注入されているので、
      // クロージャの parentAgentId が呼び出し元。他者のリストはキーすら知り得ない。
      const record = context.manager.getRecord(context.parentAgentId);
      // 防御: nested 経路でのみ登録される設計だが、レコードが無い呼び出し
      // （= メインセッション等からの誤登録・誤用）はここで拒否する。
      if (!record) {
        return textResult(
          `${NESTED_TODO_TOOL_NAME} is only available inside a subagent session.`,
          true,
        );
      }
      const key = resolveNestedTodoKey(record);
      const state = todoStores.get(key) ?? { items: [], seq: 0 };
      // 未登録キーでも読み取りは空扱いにするが、書き込み時のみ Map に載せる。
      const save = (): void => { todoStores.set(key, state); };

      switch (params.op) {
        case "list": {
          return textResult(renderTodos(state.items));
        }
        case "clear": {
          state.items = [];
          save();
          return textResult(`Cleared all todos.\n\n${renderTodos(state.items)}`);
        }
        case "set": {
          if (!params.todos || params.todos.length === 0) {
            return textResult(`op "set" requires a non-empty "todos" array.`, true);
          }
          const items: SubagentTodo[] = [];
          for (const entry of params.todos) {
            if (!entry.content || entry.content.trim().length === 0) {
              return textResult(`op "set": every todo needs a non-empty "content".`, true);
            }
            if (entry.status !== undefined && !isTodoStatus(entry.status)) {
              return textResult(`op "set": unknown status "${entry.status}".`, true);
            }
            if (entry.priority !== undefined && !isTodoPriority(entry.priority)) {
              return textResult(`op "set": unknown priority "${entry.priority}".`, true);
            }
            state.seq += 1;
            items.push({
              id: `t${state.seq}`,
              content: entry.content.trim(),
              status: entry.status ?? "pending",
              ...(entry.priority !== undefined && { priority: entry.priority }),
            });
          }
          state.items = items;
          save();
          return textResult(`Set ${items.length} todo(s).\n\n${renderTodos(state.items)}`);
        }
        case "update": {
          if (!params.todo?.id) {
            return textResult(`op "update" requires "todo.id" (see op "list").`, true);
          }
          const target = state.items.find(item => item.id === params.todo?.id);
          if (!target) {
            return textResult(`Todo "${params.todo.id}" not found in your list.`, true);
          }
          const change = params.todo;
          if (change.content !== undefined) {
            if (change.content.trim().length === 0) {
              return textResult(`op "update": "content" must not be empty.`, true);
            }
            target.content = change.content.trim();
          }
          if (change.status !== undefined) {
            if (!isTodoStatus(change.status)) {
              return textResult(`op "update": unknown status "${change.status}".`, true);
            }
            target.status = change.status;
          }
          if (change.priority !== undefined) {
            if (!isTodoPriority(change.priority)) {
              return textResult(`op "update": unknown priority "${change.priority}".`, true);
            }
            target.priority = change.priority;
          }
          if (change.content === undefined && change.status === undefined && change.priority === undefined) {
            return textResult(`op "update": nothing to change — give "status", "content", or "priority".`, true);
          }
          save();
          return textResult(`Updated (${target.id}).\n\n${renderTodos(state.items)}`);
        }
        default: {
          return textResult(`Unknown op "${(params as { op?: unknown }).op}". Use list, set, update, or clear.`, true);
        }
      }
    },
  });
  return tool;
}
