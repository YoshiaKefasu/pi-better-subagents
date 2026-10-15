import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type NestedTodoManager, resolveNestedTodoKey } from "./nested-todos.js";

/**
 * ask-user.ts — サブエージェント専用の「親セッションへの質問・回答待機」。
 *
 * nested-todos.ts と同じパターンで、agent-runner.ts が nested セッション
 * （`options.nestedRuntime` がある場合）のみに customTools として注入する。
 * ただし注入は depth 1（トップレベル子）のみ: 孫（depth ≥ 2）は親エージェントに
 * 自律的に結果を返す契約であり、親エージェントはツール実行中で回答できないため。
 *
 * なぜ必要か: 子エージェントが判断に迷って質問文を出力しても、未完了 ToDo が
 * 残っていると ToDo リマインド（buildTodoNudgePrompt）が「早帰り」と誤判定して
 * 作業続行を迫り、ユーザーの回答を待てず独断で作業を進めてしまう。ask_user は
 * 「質問したら止まる」ことをツール契約にすることでこれを防ぐ。
 *
 * 流れ:
 *   1. 子が ask_user を呼ぶ → startAskUserWaiting で待機登録 + onQuestion で
 *      親セッションへ通知（pi.sendMessage, deliverAs "steer"）。
 *   2. agent-runner のループは isAskUserWaiting を見て ToDo リマインドを
 *      スキップし、waitForAskUserAnswer で回答を待つ。
 *   3. 親（またはユーザー）が steer_subagent(agent_id, message) で回答すると
 *      deliverAskUserAnswer が待機 Promise を解決し、回答が次ターンの
 *      プロンプトとして実行される（セッション steer ではない）。
 *
 * 保持キー: nested-todos と共通の `resolveNestedTodoKey`（handle ?? id）。
 */

/** nested セッションにだけ公開するツール名。 */
export const ASK_USER_TOOL_NAME = "ask_user";

interface AskUserWaiter {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
}

interface AskUserEntry {
  /** 質問文（通知・観測用）。 */
  question: string;
  /**
   * waiter 未附着のまま届いた回答の退避。ツール実行と runner の
   * waitForAskUserAnswer 呼び出しの間に回答が届いた場合に失わない。
   */
  answer?: string;
  /** waitForAskUserAnswer で待機中の Promise の解消/拒否ハンドル。 */
  waiter?: AskUserWaiter;
}

/** キー（handle ?? id）単位の質問待機状態。 */
const askUserEntries = new Map<string, AskUserEntry>();

export interface AskUserContext {
  manager: NestedTodoManager;
  /** 呼び出し元エージェント（このツールを注入された nested セッションの所有者）。 */
  parentAgentId: string;
  /** 質問を親セッションへ通知するコールバック（agent-runner が pi.sendMessage を注入）。 */
  onQuestion?: (question: string) => void;
}

/** 質問待機中か（ask_user が呼ばれ、まだ回答が消費されていない）。 */
export function isAskUserWaiting(key: string): boolean {
  return askUserEntries.has(key);
}

/** 現在待機中の質問文（観測・テスト用）。 */
export function peekAskUserQuestion(key: string): string | undefined {
  return askUserEntries.get(key)?.question;
}

/** 待機を登録する（ask_user ツールの execute 内から呼ぶ）。 */
function startAskUserWaiting(key: string, question: string): void {
  // waiter は温存する: 二重呼び出しで既存の待機 Promise を宙吊りにしない。
  const existing = askUserEntries.get(key);
  askUserEntries.set(key, { question, waiter: existing?.waiter });
}

/**
 * 回答を待つ。abort（signal 発火）で reject し、待機状態を解除する。
 *
 * 既に回答が届いていれば（waiter 前に buffer された分）即解決する。
 * エントリが無い（質問していない・既に消費済み）場合は reject する。
 */
export function waitForAskUserAnswer(key: string, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const entry = askUserEntries.get(key);
    if (!entry) {
      reject(new Error(`No pending ask_user question for agent "${key}".`));
      return;
    }
    if (entry.answer !== undefined) {
      askUserEntries.delete(key);
      resolve(entry.answer);
      return;
    }
    if (signal?.aborted === true) {
      askUserEntries.delete(key);
      reject(new Error(`ask_user wait aborted for agent "${key}".`));
      return;
    }
    // 二重 wait の旧 Promise を置き去りにしない（実用上は到達しない防御）。
    // 旧 waiter の reject は cleanup 経由で entry を Map から落とすため、
    // 新しい waiter を附着させる前にエントリを戻し直す。
    if (entry.waiter) {
      entry.waiter.reject(new Error(`ask_user wait superseded for agent "${key}".`));
      askUserEntries.set(key, entry);
    }
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      askUserEntries.delete(key);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`ask_user wait aborted for agent "${key}".`));
    };
    entry.waiter = {
      resolve: (answer: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(answer);
      },
      reject: (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 回答を届ける（steer_subagent から呼ばれる経路）。
 *
 * waiter が附着していれば即解決、まだ waiter が無ければ entry.answer に
 * buffer して waitForAskUserAnswer の呼び出しを待つ。エントリが無ければ
 * （質問していない・消費済み）false を返し、呼び出し元は通常の steer に
 * フォールバックできる。
 */
export function deliverAskUserAnswer(key: string, answer: string): boolean {
  const entry = askUserEntries.get(key);
  if (!entry) return false;
  if (entry.waiter) {
    entry.waiter.resolve(answer);
  } else {
    entry.answer = answer;
  }
  return true;
}

/**
 * 待機を強制解除する。待機中の Promise は reject されるので、await 側
 * （agent-runner）はクリーンに break できる。レコード破棄時
 * （agent-manager.ts の removeRecord → dropNestedTodos と同一経路）用。
 */
export function clearAskUserWaiting(key: string): void {
  const entry = askUserEntries.get(key);
  if (!entry) return;
  askUserEntries.delete(key);
  entry.waiter?.reject(new Error(`ask_user wait cleared for agent "${key}".`));
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

/** 自分自身の質問用。親セッションには登録しない（subagent_todo と同じ設計）。 */
export function createAskUserTool(context: AskUserContext): ToolDefinition {
  const tool = defineTool({
    name: ASK_USER_TOOL_NAME,
    label: "Ask User",
    description:
      "Ask the parent session (main agent / user) a question or a request for confirmation and wait for the answer. " +
      "Use this whenever you need a decision, a policy choice, or an either/or judgment (e.g. plan A vs plan B) — " +
      "never guess or proceed on your own. After calling it you enter the waiting state: the parent answers " +
      "through steer_subagent and your work resumes with that answer. Do not run any tool or do any work while waiting.",
    parameters: Type.Object({
      question: Type.String({
        minLength: 1,
        description: "親セッション・ユーザーに確認したい質問や選択肢の内容。",
      }),
    }),
    execute: async (_toolCallId, params) => {
      // 呼び出し元特定: このツールは所有者セッション専用に注入されているので、
      // クロージャの parentAgentId が呼び出し元。subagent_todo と同じ防御。
      const record = context.manager.getRecord(context.parentAgentId);
      if (!record) {
        return textResult(
          `${ASK_USER_TOOL_NAME} is only available inside a subagent session.`,
          true,
        );
      }
      const question = params.question.trim();
      if (question.length === 0) {
        return textResult(`"question" must not be empty.`, true);
      }
      const key = resolveNestedTodoKey(record);
      // 待機状態を先に登録する（通知が失敗しても回答は届けられるように）。
      startAskUserWaiting(key, question);
      context.onQuestion?.(question);
      return textResult(
        "質問を親セッションに送信しました。ユーザーまたは親エージェントからの回答（steerメッセージ）を待つため待機状態に入ります。回答が届くまで独断での作業やツールの実行は行わないでください。",
      );
    },
  });
  return tool;
}
