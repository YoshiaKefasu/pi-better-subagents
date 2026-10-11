/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * There is one concurrency pool:
 *
 * - Background (`maxConcurrent`, default 10) bounds detached top-level agents.
 *   Excess agents are queued and auto-started as slots free up.
 *
 * Nested children take no slot — see `occupiesPoolSlot`.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { assignHandle, handleBase } from "./mention.js";
import { isUpstreamUnreachableError, isUsageLimitError } from "./model-fallback-chain.js";
import { describeModel } from "./model-resolver.js";
import { dropNestedTodos } from "./nested-todos.js";
import { loadSubagentsRetrySettings, type SubagentsRetrySettings } from "./subagents-retry-settings.js";
import type { AgentInvocation, AgentRecord, IsolationMode, MentionResolution, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import type { CompiledSchema } from "./workflow/json-schema.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
/**
 * Fired once per assistant `message_end`, for EVERY agent this manager owns —
 * top-level and nested alike, spawns and resumes. The one place where each
 * message is seen exactly once: `AgentRecord.lifetimeUsage` is deliberately
 * double-booked into ancestors (see `nested-tools.ts`) so a hidden child's spend
 * shows up on the record a human can see, which makes those records useless as
 * a basis for anything that must not count a message twice — parent-session
 * accounting above all.
 */
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/**
 * Default max concurrent background agents.
 *
 * Raised from 4 when top-level spawns started defaulting to background: every
 * top-level agent then takes a slot, and a limit of 4 would have silently
 * queued the tail of exactly the parallel fan-outs the `Agent` tool description
 * tells the model to send.
 */
const DEFAULT_MAX_CONCURRENT = 10;

/**
 * How long a finished record stays in memory after its run ended.
 *
 * Long, because a record is the only thing that answers `@handle` and
 * `Agent({ resume })` from memory: the conversation itself lives on disk
 * (`.jsonl`, `archive/` after 24h idle, `.output` as a last resort), so a
 * record is a cache, not the source of truth. 24h matches the archive window —
 * by the time archiving would consider a transcript stale, its record is gone
 * too, and a resume then goes straight to the files on disk.
 *
 * At {@link SESSION_DETACH_AFTER_MS} the live `session` object is shut down and
 * detached, so what stays in memory for those 24 hours is a small record
 * (ids, names, counts, timestamps, two file paths) rather than a whole agent
 * session. Resuming such a record reopens the file — see `spawnResolved`.
 */
const RECORD_RETAIN_MS = 24 * 60 * 60_000;

/**
 * How long a finished record keeps its live `session` object. The session is
 * what holds the extension runner and the message array, so it is the
 * expensive half; the record's own bookkeeping is not. Ten minutes is long
 * enough for anything that reads the record right after completion (results,
 * widgets, steering) and short enough that an idle session stops paying for
 * sessions it will never touch again.
 */
const SESSION_DETACH_AFTER_MS = 10 * 60_000;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

/**
 * Whether a record occupies one of the `maxConcurrent` background slots.
 * Nested children don't: their parent already holds a slot, so counting (and
 * therefore queueing) them would deadlock a parent that waits on its own child.
 *
 * Note this bounds nothing horizontally — the depth cap limits how DEEP nesting
 * goes, not how WIDE. A parent's only limit on concurrent children is that each
 * spawn costs it a turn, which is unbounded when max turns is unlimited.
 */
function occupiesPoolSlot(
  record: Pick<AgentRecord, "isBackground" | "parentAgentId" | "workflowId">,
): boolean {
  return !!record.isBackground && isTopLevelAgent(record);
}

/**
 * Whether a record is one of the session's own agents, rather than something
 * another agent or a workflow owns.
 *
 * The single definition behind every user-facing surface — the fleet list, the
 * widget, the `/agents` menus, `@handle` resolution, and the completion events
 * and session entries. An owned child reports through its owner, so surfacing
 * it separately would double-count the same work in the places a person reads.
 */
export function isTopLevelAgent(
  record: Pick<AgentRecord, "parentAgentId" | "workflowId">,
): boolean {
  return record.parentAgentId === undefined && record.workflowId === undefined;
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  /**
   * Optional memorable name for this instance, becoming a second handle
   * (`@auth-audit`) alongside the type-derived one. Slugged, not validated —
   * anything unusable degrades via `handleBase` rather than failing the spawn.
   */
  name?: string;
  /**
   * Reopen this pi session file instead of starting a fresh conversation, so a
   * mention of an evicted agent continues where it left off. The agent's
   * definition is still resolved from its type, so the continuation runs under
   * the type's CURRENT config.
   */
  resumeSessionFile?: string;
  /**
   * Take an evicted agent's names back verbatim instead of allocating fresh
   * ones, so a resumed conversation keeps the handle the user just typed —
   * `handleBase(type)` cannot reproduce a numbered `explore-2`. Safe without an
   * `assignHandle` pass because no live record holds them: this is used when
   * reopening a finished agent, which by definition is not running.
   *
   * `id` reuses the evicted record's ID so a resumed conversation keeps a
   * stable identity. Reused only when no live record holds it (see `spawn`);
   * execution metadata (`startedAt` etc.) is always fresh — only the ID is
   * carried over, never the run state.
   *
   * Internal capability, like `resumeSessionFile`: a forged handle would
   * duplicate a live agent's name and make `resolveMention` ambiguous, so
   * `spawnTopLevel` strips it from anything a caller sends.
   */
  reclaim?: { handle: string; alias?: string; id?: string };
  model?: Model<any>;
  /**
   * モデルフォールバック連鎖の残り（先頭を除く生文字列）。runAgent が切替時に
   * 遅延解決する。Agent ツール / workflow の agent() / nested 呼び出しが
   * parseModelChain で分解して渡す。カンマ無し指定では未設定。
   */
  modelFallbacks?: string[];
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip whichever pool's queue check applies to this spawn — start immediately
   * even if the configured concurrency limit would otherwise queue it. The slot
   * is still COUNTED once the run starts, so a bypassing spawn transiently
   * exceeds the limit rather than being invisible to it.
   *
   * Used by the scheduler, so a fired job can't be deferred past its trigger
   * window, and by the `/agents` agent-file generator, which has no way to
   * cancel a wait (see its call site).
   */
  bypassQueue?: boolean;
  /**
   * The workflow run this child belongs to, when a workflow spawned it.
   *
   * Ownership, not decoration. A workflow's children are the workflow's — they
   * report through its card, its notification and its dialog, so they are
   * filtered out of every top-level surface exactly as nested children are, and
   * they take no `maxConcurrent` slot: the run has its own concurrency cap, and
   * counting them twice would let one workflow starve the whole session.
   */
  workflowId?: string;
  /**
   * Make the child report through a `StructuredOutput` tool built from this
   * compiled schema. Set only by the workflow host, for `agent({ schema })`.
   */
  structuredOutput?: CompiledSchema;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /**
   * Last chance to look at an isolated agent's worktree, awaited immediately
   * before it is committed to a branch and removed.
   *
   * Exists because that removal happens inside the settle path, before
   * `spawnAndWait` resolves: by the time a caller has the finished record, the
   * directory the child actually wrote in is gone. Anything that must inspect
   * or verify that tree — a workflow `gate` is the motivating case — has to run
   * here or it silently inspects the main tree instead.
   *
   * Fires only on the normal settle path, and only when a worktree was created.
   * Not on the error path and not on the stop-during-copy guard: those are
   * already failing, and delaying cleanup there would leak a copy for no gain.
   * A rejection is swallowed — the hook can never keep the worktree alive.
   */
  onBeforeWorktreeCleanup?: (worktreePath: string) => Promise<void>;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /**
   * Called synchronously once the record is in the map and its promise is set,
   * before `onSessionCreated` fires — where callers attach the output file.
   *
   * Carried on the options rather than parked on the manager for the duration
   * of a spawn: `startAgent` can run at drain time, long after any such field
   * would have been restored, and the callback would silently never fire (or
   * fire into an unrelated caller's closure).
   */
  onSpawned?: (id: string) => void;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Root session id, inherited by nested launches so transcripts stay grouped. */
  rootSessionId?: string;
}

interface ResumeOptions {
  /**
   * Run the resumed turn detached in the background: return immediately with
   * the record still "running" (or "queued" at the concurrency limit) and
   * notify on completion via onComplete, exactly like a background spawn.
   * Default (false/undefined) runs the resume inline and returns the settled
   * record — the historical behavior.
   */
  isBackground?: boolean;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /**
   * Background resume only: called synchronously when the run actually starts —
   * immediately, or later from drainQueue. Callers wire per-run side effects
   * (output-file streaming) here rather than at the call site, so a resume that
   * is stopped while still queued never leaves a subscription behind: `abort()`
   * drops a queued record without reaching `settle()`, which is what would have
   * torn that subscription down.
   */
  onStarted?: () => void;
}

/** Best-effort ceiling on one child's shutdown handlers, so teardown can't strand a quit. */
const CHILD_SHUTDOWN_TIMEOUT_MS = 3_000;

/** resolveRecord の id prefix 解決に必要な最低文字数。disk 側 (findSessionOnDisk・ID prefix) と同値。 */
const MIN_ID_PREFIX_LEN = 6;

/**
 * 進捗によるリトライ予算リセットの上限回数。実機 Pi では失敗した resumeAgent も
 * 再送プロンプトとエラー応答を messages に push するため、進捗判定は successTurns
 * ベース（下記 countSuccessfulAssistantTurns）にしているが、それでも「1ターン
 * だけ進んでは永遠に切断を繰り返す」経路で予算が開き続けるのを防ぐ安全弁。
 * ユーザー想定の VPN 回転等の単発切断（数回）は十分に収まる。
 */
const MAX_PROGRESS_RESETS = 10;

/**
 * セッション内の「成功した assistant ターン数」。stopReason が "error" /
 * "aborted" の assistant メッセージは除外する — 失敗した resumeAgent 呼び出し
 * 自体がエラー応答（role: "assistant", stopReason: "error"）を messages に
 * push するため、素の messages.length は連続失敗でも増え、進捗判定に使うと
 * 予算が毎回リセットされて無限ループする。
 */
function countSuccessfulAssistantTurns(messages: readonly unknown[] | undefined): number {
  if (messages === undefined) return 0;
  let count = 0;
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const m = message as { role?: unknown; stopReason?: unknown };
    if (m.role !== "assistant") continue;
    if (m.stopReason === "error" || m.stopReason === "aborted") continue;
    count++;
  }
  return count;
}

const RETRYABLE_STREAM_ERRORS = [
  "stream disconnected",
  "stream ended",
  "ended before",
  "disconnected before completion",
  "stream closed before response.completed",
  "upstream execution failed",
  // 以下はトランスポート層の切断。CPA側で実測された上流のTCP強制切断が該当する:
  // `Post "https://.../v1/responses": read tcp ... wsarecv: An existing
  // connection was forcibly closed by the remote host`。
  // 会話自体は壊れていないため、同一セッションの継続として自動再送する。
  "forcibly closed",
  "connection reset",
  "econnreset",
  "econnaborted",
  "connection aborted",
  "socket hang up",
  "broken pipe",
  "epipe",
  "read tcp",
  "wsarecv",
] as const;

/**
 * 接続確立失敗・タイムアウト系の一時的な通信断。該当すれば同一リクエストの
 * 再送で通る見込みが高いため、stream 切断より厚い予算でリトライする。
 * 文言の根拠: @earendil-works/pi-ai の dist/utils/retry.ts
 * `RETRYABLE_PROVIDER_ERROR_PATTERN`（"fetch failed" / "ENOTFOUND" /
 * "EAI_AGAIN" / "timed out" / "terminated" / "other side closed" 等）と
 * Node/undici の実測エラー（ECONNREFUSED / ETIMEDOUT / UND_ERR_* 等）。
 * 429・quota 系は含めない（使用制限はフォールバック連鎖の役目）。
 * 照合は小文字化済みテキストへの部分一致のため小文字で書く。
 */
const TRANSIENT_RETRYABLE_ERRORS = [
  "fetch failed",
  "econnrefused",
  "connection refused",
  "etimedout",
  "ehostunreach",
  "host unreachable",
  "ehostdown",
  "enetunreach",
  "network unreachable",
  "enetdown",
  "enetreset",
  "enotfound",
  "getaddrinfo",
  "eai_again",
  "upstream connect",
  "reset before headers",
  "socket connection was closed",
  "connection lost",
  "connection closed",
  "connection error",
  "network error",
  "other side closed",
  "premature close",
  "tunnel",
  "timed out",
  // pi-ai の `timed? out` 対応: "timed out" では "time out"（例: "connect time out"）
  // を拾えないため別途含める。
  "time out",
  "timeout",
  "aborterror",
  "the operation was aborted",
  "request aborted",
  "aborted",
  "terminated",
  "und_err",
  "websocket closed",
  "websocket error",
  "connect timeout",
  "idle timeout",
  "connect_timeout",
  "idle_timeout",
  // pi-ai RETRYABLE_PROVIDER_ERROR_PATTERN 由来（実分類で NONE だった分のみ追記）。
  "http2 request did not get a response",
  "exceeded request buffer limit while retrying upstream",
  "provider returned error",
  "resourceexhausted",
  // 一時的な TLS 再交渉失敗の可能性があるため残す。証明書自体の確定失敗は
  // NON_TRANSIENT_CERT_ERRORS で先に弾く。
  "handshake failure",
] as const;

/**
 * 証明書系の確定失敗 — 同一リクエスト再送では絶対に回復しないため transient
 * 対象外。isTransientRetryableFailure が TRANSIENT_RETRYABLE_ERRORS より先に
 * 評価し、含めば false（none へ落とす）。`handshake failure` は含めない
 * （一時的な再交渉失敗の可能性があるため transient に残す）。
 * 照合は小文字化済みテキストへの部分一致のため小文字で書く。
 */
const NON_TRANSIENT_CERT_ERRORS = [
  "certificate has expired",
  "self signed certificate",
  "self-signed certificate",
  "unable to verify",
  "certificate verify failed",
  "unable to get local issuer certificate",
  "unable to get issuer cert",
  "wrong version number",
] as const;

function isRetryableStreamFailure(error: unknown): boolean {
  return RETRYABLE_STREAM_ERRORS.some((needle) => retryableSearchText(error).includes(needle));
}

function isTransientRetryableFailure(error: unknown): boolean {
  const text = retryableSearchText(error);
  // 証明書系の確定失敗は再送しても回復しないため先に弾く（transient 対象外）。
  // `handshake failure` は含めない（一時的な再交渉失敗の可能性があるため残す）。
  if (NON_TRANSIENT_CERT_ERRORS.some((needle) => text.includes(needle))) return false;
  return TRANSIENT_RETRYABLE_ERRORS.some((needle) => text.includes(needle));
}

/**
 * cause チェーン内の数値ステータス（{ status: 429 } 等）を探す。
 * retryableSearchText はメッセージ文字列だけを flatten するため、数値だけを
 * 持つ cause オブジェクトは "[object Object]" に埋もれて 429 を見逃す。
 * ここではメッセージ化せず、各ノードの STATUS_KEYS 相当を直接見る。
 */
function hasUsageLimitStatusInChain(error: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur == null || seen.has(cur)) continue;
    seen.add(cur);
    if (cur instanceof Error) {
      const agg = (cur as AggregateError).errors;
      if (Array.isArray(agg)) stack.push(...agg);
      stack.push((cur as { cause?: unknown }).cause);
    } else if (typeof cur === "object") {
      const rec = cur as Record<string, unknown>;
      for (const key of ["status", "statusCode", "status_code", "code"] as const) {
        const value = rec[key];
        if (value === 429 || value === "429") return true;
      }
      if ("cause" in rec) stack.push(rec.cause);
      if (Array.isArray((rec as { errors?: unknown }).errors)) {
        stack.push(...((rec as { errors?: unknown }).errors as unknown[]));
      }
    }
  }
  return false;
}

/** spawn 失敗の再送分類。429 を厚くリトライしないことが最優先の不変条件。 */
export type RetryFailureFamily = "usage-limit" | "upstream" | "transient" | "stream" | "none";

/**
 * failure を再送方針に分類する純粋関数。優先順位は
 * usage-limit > upstream > stream > transient > none。リストは重複し得る
 * （例: "fetch failed / read ECONNRESET" は `econnreset` で stream が先に当たる）。
 * stream を transient より先に評価して既存の挙動を優先している。
 * `upstream` も stream / transient より先に判定する — 502 の実測文言
 * （"502 | upstream execution failed: ... unreachable"）は両方の文言を
 * 同時に含むため、stream を先だと同一モデルでの再送ループに入ってしまう。
 * upstream は「同じモデルで粘らない。フォールバック連鎖へ委ねる」扱い。
 * NOTE: model-fallback-chain.ts の classifyRetryFailure（agent-runner の
 * own-retry/fallback/as-is 分岐用）とは名前も返り値も別物。混同注意。
 */
export function classifyRetryFailureFamily(failure: unknown): RetryFailureFamily {
  // usage-limit 判定は flatten した全文に対しても走らせる。isUsageLimitError は
  // トップレベルの message と数値 status しか見ないため、`Error("fetch failed") +
  // cause:{status:429}` のように 429 が cause に埋まると見逃す。flatten テキストに
  // "fetch failed" があっても 429 があれば usage-limit を優先する。
  if (isUsageLimitError(failure)) return "usage-limit";
  if (isUsageLimitError(retryableSearchText(failure))) return "usage-limit";
  if (hasUsageLimitStatusInChain(failure)) return "usage-limit";
  // 上流到達不能（502 等）。usage-limit と同じく同一モデルでの再送はしない。
  if (isUpstreamUnreachableError(failure)) return "upstream";
  if (isUpstreamUnreachableError(retryableSearchText(failure))) return "upstream";
  if (isRetryableStreamFailure(failure)) return "stream";
  if (isTransientRetryableFailure(failure)) return "transient";
  return "none";
}

/**
 * リトライ判定用の照合テキスト: error.message だけでなく `cause` チェーンを
 * 再帰 flatten する (ラップされた提供者エラーに対応)。AggregateError の
 * `errors` 配列も展開する。循環参照は seen で打ち切る。
 */
function retryableSearchText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur == null || seen.has(cur)) continue;
    seen.add(cur);
    if (cur instanceof Error) {
      parts.push(cur.message);
      // AggregateError.errors を先に積む (LIFO のため cause より後に読まれる)。
      const agg = (cur as AggregateError).errors;
      if (Array.isArray(agg)) stack.push(...agg);
      stack.push((cur as { cause?: unknown }).cause);
    } else if (typeof cur === "object") {
      const rec = cur as Record<string, unknown>;
      if ("cause" in rec) stack.push(rec.cause);
      else parts.push(String(cur));
    } else {
      parts.push(String(cur));
    }
  }
  return parts.join("\n").toLowerCase();
}

/**
 * 中断対応の待機。agent-runner.ts の sleepAbortable と同一パターン。
 * いずれかの signal が abort 済み／途中で abort されたら即 resolve する。
 * 呼び出し後の abort ガードは残すこと（resolve 後に abort された場合のため）。
 */
function sleepAbortableMs(ms: number, signals: (AbortSignal | undefined)[]): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signals.some(signal => signal?.aborted === true)) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener("abort", done);
      resolve();
    }
    for (const signal of signals) signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * リトライ突入ゲート（.then / .catch 両経路で共有）。classifyRetryFailureFamily
 * が usage-limit > upstream > stream > transient > none の順で判定済みのため、
 * ここでは `!isUsageLimitError(...)` の再判定はしない（重複排除）。
 * usage-limit と upstream は「同じモデルで粘らない」ためここでは false —
 * フォールバック連鎖（runAgent 側）へ委ねる。
 */
function shouldRetry(
  failure: unknown,
  settings: SubagentsRetrySettings,
  record: Pick<AgentRecord, "status">,
  options: Pick<SpawnOptions, "structuredOutput">,
): boolean {
  if (!failure) return false;
  if (!settings.enabled) return false;
  if (options.structuredOutput) return false;
  if (record.status === "stopped") return false;
  const family = classifyRetryFailureFamily(failure);
  if (family !== "stream" && family !== "transient") return false;
  const budget = family === "transient" ? settings.transientMaxAttempts : settings.maxAttempts;
  return budget > 1;
}

/**
 * transient 再送の指数バックオフ: `transientBaseDelayMs * 2^(attempt-2)` を
 * `transientBackoffCapMs` で頭打ちする。attempt=2（初回再送）は base のまま。
 */
function transientRetryDelayMs(settings: SubagentsRetrySettings, attempt: number): number {
  const delay = settings.transientBaseDelayMs * 2 ** Math.max(0, attempt - 2);
  const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
  return Math.min(safeDelay, settings.transientBackoffCapMs);
}

/** failure（string | Error | その他）をログ・再送プロンプト用の文字列にする。 */
function retryFailureText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** 長文・複数行の failure をログ用に先頭1行へ丸める。 */
function retryFailureHeadline(failure: string): string {
  return failure.split("\n", 1)[0].slice(0, 200);
}

function isAgentStopped(record: Pick<AgentRecord, "status">): boolean {
  return record.status === "stopped";
}

/**
 * Close the extension lifecycle `runAgent` opened with `bindExtensions`, then dispose.
 *
 * `AgentSession.dispose()` only calls `ExtensionRunner.invalidate()` — pi emits the event
 * itself in `AgentSessionRuntime.dispose()` beforehand, and this is the one place that binds
 * extensions onto a session without going through that path. Without the emit, everything an
 * extension armed in `session_start` leaks once per spawn, and its next tick throws
 * `assertActive()` from a bare timer callback — an uncaughtException that kills pi (#242).
 */
async function shutdownChildSession(session: AgentSession | undefined): Promise<void> {
  try {
    const runner = session?.extensionRunner;
    // Optional all the way down: on a pi without the getter, or a stubbed session from a
    // partial `onSessionCreated`, skip the emit — the same degrade as before this fix.
    if (runner?.hasHandlers?.("session_shutdown")) {
      // Raced, not awaited outright. `emit` runs every handler serially with no timeout of
      // its own, and dispose() is reached from pi's own `session_shutdown` with the TUI
      // already torn down — one hung handler would leave a dead terminal.
      await Promise.race([
        runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<void>(resolve => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS).unref()),
      ]);
    }
  } catch { /* a partial session must degrade, not take the teardown down with it */ }
  // Always, even on timeout: disposal is what this function ultimately exists to do.
  try { session?.dispose?.(); } catch { /* ignore */ }
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private maxConcurrent: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /**
   * Startup phases, keyed by agent id. `spawn()` still returns synchronously,
   * but an agent using worktree isolation is not running yet when it does —
   * copying the repo is an awaited git call. This is what `awaitStartup` hands
   * callers that must fail their tool call on a startup failure, and what
   * `waitForAll` waits on while a record is "running" with no `promise` yet.
   * Entries are dropped once the run is underway, and kept (rejected) after a
   * startup failure so a late `awaitStartup` still sees it.
   */
  private startups = new Map<string, Promise<void>>();

  /**
   * Agents waiting to start. One queue for the single pool: `drainQueue` starts
   * the earliest entry while a background slot is free.
   */
  private queue: { id: string; start: () => Promise<void> }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onUsage?: OnAgentUsage,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onUsage = onUsage;
    this.maxConcurrent = maxConcurrent;
    // Reaps finished records on a one-minute cadence (never per message): it
    // detaches a completed run's session after 10 minutes and drops the record
    // after 24 hours. Both are memory bounds — nothing on disk expires with
    // them, and a resume picks the conversation back up from its file.
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Whether the background pool still has room for one more agent. */
  private poolHasRoom(): boolean {
    return this.runningBackground < this.maxConcurrent;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   *
   * The id comes back synchronously, but with `isolation: "worktree"` the agent
   * is not running yet when it does — the repo copy is an awaited git call.
   * Callers that must fail a tool call on a startup failure await
   * `awaitStartup(id)`; everyone else sees it on the record (status "error").
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    // ID再利用: disk reopen は会話ファイルを開き直した新規レコードとして
    // 復活するため、復活元のIDを reclaim.id で引き継いで会話の同一性を保つ。
    // 現存レコードと衝突する場合（同IDが生きている）は従来通り新規採番する —
    // ID重複は絶対に起こさない。
    // startedAt 等の実行メタは下の record 構築で常に新規にする — 引き継ぐのは
    // ID だけであり、実行状態（result/error/completedAt 等）は持ち越さない。
    const reclaimedId = options.reclaim?.id;
    const id =
      reclaimedId !== undefined && reclaimedId !== "" && !this.agents.has(reclaimedId)
        ? reclaimedId
        : randomUUID();
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      // Owned children — nested, or a workflow's — are filtered out of every
      // top-level surface, so no handle: nothing can address them and they must
      // not consume a name a top-level sibling could otherwise take.
      handle: !isTopLevelAgent(options)
        ? undefined
        // A reclaimed handle is used as-is: it belongs to the conversation this
        // spawn is reopening, and re-deriving it would lose the numbering.
        : options.reclaim?.handle ?? assignHandle(handleBase(type), this.takenHandles()),
      description: options.description,
      // Reclaimed here, or filled in below from `name` — in which case it must
      // see the handle this record just took, since both come out of the same
      // namespace.
      alias: isTopLevelAgent(options) ? options.reclaim?.alias : undefined,
      // Overwritten below when the spawn is actually queued; a queued spawn
      // flips to "queued" there rather than being guessed at here, since the
      // decision needs the finished record.
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // an inline spawn a caller is awaiting (spawnAndWait), undefined = caller
      // never declared it (e.g. a cross-extension RPC spawn). The widget's
      // background-only filter excludes only explicit `false`, so undefined
      // agents — which have no inline surface — stay visible instead of
      // vanishing.
      isBackground: options.isBackground,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      workflowId: options.workflowId,
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId: options.rootSessionId,
      // retryStreamFailure と同じ解決点。resume 経路（spawn コンテキスト無し）が
      // この値を頼りに同じ subagents-retry 設定を読む。
      configCwd: options.configCwd ?? ctx.cwd,
    };
    this.agents.set(id, record);
    // After the insert, so `takenHandles()` already counts this record's own
    // handle — a spawn named after its own type gets `explore-2`, not a
    // duplicate `explore` that would make resolution ambiguous.
    if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
      record.alias = assignHandle(handleBase(options.name), this.takenHandles());
    }

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    // Only a detached top-level spawn queues: it is the kind that holds a
    // `maxConcurrent` slot (see `occupiesPoolSlot`). Everything else — a nested
    // child, a workflow's child, an inline `spawnAndWait` — starts immediately
    // and is counted once it runs.
    if (occupiesPoolSlot(record) && !options.bypassQueue && !this.poolHasRoom()) {
      // Queue it — started when a running agent completes.
      record.status = "queued";
      // A queued record never reaches startAgent's signal wiring, so arm the
      // parent abort here or Esc could not release the position.
      if (!this.armQueuedAbort(id, options.signal)) return id;
      this.queue.push({
        id,
        start: () => this.launch(id, record, args, true),
      });
      return id;
    }

    void this.launch(id, record, args, false);
    return id;
  }

  /**
   * Wire a parent abort signal for a record that is about to be QUEUED.
   * `startAgent` does this for running agents, and a queued record never gets
   * there, so without this Esc could not release a queue position.
   *
   * Returns false when the signal is ALREADY aborted, in which case the record
   * is stopped here and must not be enqueued: `addEventListener` never fires on
   * an aborted signal, so nothing would ever stop a record nobody can reach.
   *
   * The listener is left in place when the agent starts. `startAgent` adds its
   * own, so both fire on a later abort, but `abort()` on an already-stopped
   * record is a no-op — so detaching would only be tidiness, and tidiness the
   * `abortAll`/`dispose` paths could not offer anyway.
   */
  private armQueuedAbort(id: string, signal?: AbortSignal): boolean {
    if (signal === undefined) return true;
    if (signal.aborted) {
      const record = this.agents.get(id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
      }
      return false;
    }
    signal.addEventListener("abort", () => this.abort(id), { once: true });
    return true;
  }

  /**
   * Kick off an agent's startup and register it under `startups`. The returned
   * promise never rejects — the failure is delivered through `awaitStartup`,
   * and to the record.
   *
   * @param queued - Whether this start came from the queue drain. A drain can
   *   be minutes after `spawn()` returned, and nobody is awaiting
   *   `awaitStartup` by then, so a failure has to live on the record as status
   *   "error" — what drainQueue did when the throw was still synchronous. An
   *   immediate start instead drops the record, exactly as the throw out of
   *   `spawn()` did: no orphan in `listAgents()`, and the handle goes back.
   */
  private launch(id: string, record: AgentRecord, args: SpawnArgs, queued: boolean): Promise<void> {
    const startup = this.startAgent(id, record, args).then(
      () => { this.startups.delete(id); },
      (err) => {
        this.startups.delete(id);
        if (queued) {
          // Mirrors settleRun: an inline caller gets this failure as a throw
          // out of spawnAndWait, so an unconsumed record would ALSO nudge the
          // session about it — the same failure reported twice.
          if (!record.isBackground) record.resultConsumed = true;
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
          record.completedAt = Date.now();
          this.onComplete?.(record);
        } else {
          this.agents.delete(id);
        }
        // The agent never kept its slot (startAgent gives it back on failure),
        // so anything queued behind it can go now.
        this.drainQueue();
        throw err;
      },
    );
    this.startups.set(id, startup);
    // Nothing is obliged to await `startups` — swallow the rejection once here
    // so an unawaited startup can't take the process down, and hand callers
    // (drainQueue) that swallowed promise.
    return startup.catch(() => {});
  }

  /**
   * Resolves once the agent is actually running, and rejects with the startup
   * failure (strict worktree isolation) that `spawn()` used to throw before the
   * repo copy became async. Resolves immediately for an agent that is already
   * running, still queued, or unknown — so callers can await it unconditionally.
   *
   * Call it in the same tick as the `spawn()` it belongs to: a failed startup
   * takes its record (and this entry) with it, exactly as the throw did.
   */
  awaitStartup(id: string): Promise<void> {
    return this.startups.get(id) ?? Promise.resolve();
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private async startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
  ) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Take the running state — and with it the concurrency slot — BEFORE the
    // first await. Creating a worktree is an awaited git call, and drainQueue
    // reads the pool counter synchronously in a loop: incrementing after the
    // await would let it start every queued agent at once while the first is
    // still copying its repo. Claiming "running" here also keeps abort() and
    // abortAll() able to reach an agent whose worktree is still being created.
    //
    // The pool decision is resolved ONCE, here, and carried to `settleRun`
    // below: `maxConcurrent` is user-changeable from `/agents → Settings`
    // mid-run, so recomputing it at settle time would decrement a counter this
    // run never charged (counter underflow, limit silently lifted) or skip the
    // decrement for one it did (leaked slot — every later queued spawn waits
    // forever). The two startup exits below never reach `settleRun`, so they
    // hand the slot back themselves.
    const holdsSlot = occupiesPoolSlot(record);
    const releaseSlot = () => {
      if (holdsSlot) this.runningBackground--;
    };
    record.status = "running";
    record.startedAt = Date.now();
    if (holdsSlot) this.runningBackground++;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done BEFORE
    // the run is kicked off so a failure doesn't leave a half-running agent.
    // The project switch is enforced here as well as at the tool boundary
    // because cross-extension RPC forwards its options unvalidated — a schema
    // that omits the field can't stop a caller that never saw the schema.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree" && isWorktreeIsolationEnabled()) {
      const wt = await createWorktree(pi, baseCwd, id);
      if (!wt) {
        releaseSlot();
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);

      // No longer "running" means a stop landed while the copy was being made
      // (abort(), abortAll()) — a window that did not exist when creation was
      // synchronous. The record is already terminal, so launching the run would
      // burn tokens on work nobody is waiting for: discard the fresh (and by
      // definition unchanged) worktree instead.
      if (record.status !== "running") {
        releaseSlot();
        record.worktreeResult = await cleanupWorktree(pi, baseCwd, wt, options.description);
        this.drainQueue();
        return;
      }
    }

    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      // A queued spawn can start minutes after the caller handed us its signal,
      // by which time it may already be aborted — and `addEventListener` would
      // never fire, leaving a child the parent can no longer reach.
      if (options.signal.aborted) this.abort(id);
      else {
        const onParentAbort = () => this.abort(id);
        options.signal.addEventListener("abort", onParentAbort, { once: true });
        detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
      }
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    const retrySettings = loadSubagentsRetrySettings(options.configCwd ?? ctx.cwd);
    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      // The on-disk identity, so a finished agent is reachable by handle and
      // alias as well as id once its record is gone from memory.
      handle: record.handle,
      alias: record.alias,
      model: options.model,
      modelFallbacks: options.modelFallbacks,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      structuredOutput: options.structuredOutput,
      resumeSessionFile: options.resumeSessionFile,
      nested: options.parentAgentId !== undefined,
      workflow: options.workflowId !== undefined,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      // Set iff a worktree was created (see above) — names the directory the
      // copy came from, so the prompt can tell the agent not to work there.
      worktreeBase: worktreeCwd ? baseCwd : undefined,
      configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onSessionCreated: (session) => {
        record.session = session;
        // Capture now, while the session object exists: after eviction this
        // path is the only thing that can reopen the conversation, and an
        // in-memory session reports undefined, which correctly means
        // "nothing to come back to".
        // Optional chaining, not defensiveness for its own sake: this is the
        // only field read off the session at creation, so an older pi or a
        // stubbed session must degrade to "not resumable" rather than throw
        // and take the whole spawn down with it.
        record.sessionFile = session.sessionManager?.getSessionFile?.();
        // Same reason, different field: the model and thinking level are only
        // knowable once pi has resolved its defaults and clamped the level to
        // what the model supports. Writing them back here makes the record
        // authoritative, so every surface reads one place instead of each
        // re-deriving "session, else the request" for itself.
        if (session.model) {
          record.invocation ??= {};
          // Read the kept request first: a caller's level survives being clamped
          // AND, one line later, being replaced by the effective one.
          const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
          Object.assign(record.invocation, describeModel(session.model));
          // Guarded for the reason above: a session that reports no level keeps
          // the request rather than losing it. Overwriting unconditionally would
          // turn an older or stubbed session into a blank `thinking:` tag, which
          // is worse than the stale-but-true value it replaced.
          if (session.thinkingLevel) {
            record.invocation.thinking = session.thinkingLevel;
            if (requested && requested !== session.thinkingLevel) {
              record.invocation.requestedThinking = requested;
            }
          }
        }
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(async ({ responseText, session, aborted, steered, failure, structuredJson, structuredRetried }) => {
        record.session = session;
        // フォールバックでモデルが切り替わっていたら表示を追随させる
        // （onSessionCreated 時のスナップショットは切替前のモデルのままなため）。
        // describeModel の2キーのみ上書きし、requested* は残す。
        // session 自体が無い（起動失敗のモック等）場合は何もしない。
        if (session?.model) {
          record.invocation ??= {};
          Object.assign(record.invocation, describeModel(session.model));
        }
        let finalResponseText = responseText;
        let finalFailure = failure;
        // 判定の優先順位：classifyRetryFailureFamily（usage-limit > upstream > stream / transient > none）。
        // 429 系・502 系はリトライに回さない — runAgent 内でフォールバック
        // 済み（枯渇時を含む）のため、ここで同一モデルに粘ると CPA 側の
        // クールダウンを汚染する。RETRYABLE_STREAM_ERRORS 側に 429 系の
        // 文言が混ざっていないことも確認済み（混ざれば除外する方針）。
        // structured 期待の spawn は stream リトライの対象外: retry は
        // schema の無い resumeAgent で継続するため、成功しても
        // structuredJson が古いまま completed になり schema 契約が崩れる。
        // 選択肢 (b) の再取得ではなく (a) 除外を選んだ理由は、再取得には
        // runner の resume 結果への schema 適用が必要で、agent-runner 側の
        // 変更になるため (本ラウンドの対象外)。
        // 再送予算は family 別：transient（通信断）は stream 切断より厚く粘る。
        if (shouldRetry(failure, retrySettings, record, options)) {
          const retryResult = await this.retryStreamFailure(record, retrySettings, options.signal, failure, options);
          if (retryResult.succeeded) {
            finalResponseText = retryResult.text;
            finalFailure = undefined;
          } else {
            finalFailure = retryResult.failure;
          }
        }
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          // Precedence: a hard abort keeps "aborted"; then a failed final turn
          // (provider error that pi resolved instead of rejecting, #144) is an
          // honest "error" — not a completion with an empty or stale result.
          if (aborted) {
            record.status = "aborted";
          } else if (finalFailure) {
            record.status = "error";
            record.error = finalFailure;
          } else {
            record.status = steered ? "steered" : "completed";
            record.error = undefined;
          }
        }
        record.result = finalResponseText;
        // Kept beside `result`, never inside it: `result` is prose meant for a
        // reader — it is previewed, transcribed, and appended to below — while
        // this is a machine-readable payload one caller asked for by schema.
        record.structuredJson = structuredJson;
        record.structuredRetried = structuredRetried;
        record.session = session;
        record.completedAt ??= Date.now();

        detach();

        await this.settleSpawnSuccess(record, { id, pi, baseCwd, customCwd, options, holdsSlot });
        return responseText;
      })
      .catch(async (err) => {
        let retrySucceeded = false;
        // .then 側と同じゲート（shouldRetry に一本化）。429 系はリトライ対象外。
        if (shouldRetry(err, retrySettings, record, options)) {
          const retryResult = await this.retryStreamFailure(record, retrySettings, options.signal, err, options);
          if (retryResult.succeeded) {
            retrySucceeded = true;
            record.status = "completed";
            record.error = undefined;
            record.result = retryResult.text;
            record.completedAt ??= Date.now();
          } else {
            err = new Error(retryResult.failure);
          }
        }

        if (retrySucceeded) {
          detach();
          // .then 側と同一の成功 tail。旧コードの外側 try/catch を維持:
          // cleanupWorktree の throw はここでは飲み込む (従来通り)。
          try {
            await this.settleSpawnSuccess(record, { id, pi, baseCwd, customCwd, options, holdsSlot });
          } catch { /* ignore cleanup errors */ }
          return record.result ?? "";
        }

        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
        }

        this.abortOwnedChildren(id);

        this.settleRun(record, false, holdsSlot);
        return "";
      });

    record.promise = promise;

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming
    // starts. Read off the options, so a spawn that started from a queue drain
    // still reaches the caller that queued it.
    options.onSpawned?.(id);
  }

  private async retryStreamFailure(
    record: AgentRecord,
    settings: SubagentsRetrySettings,
    parentSignal: AbortSignal | undefined,
    initialFailure: unknown,
    options: SpawnOptions,
  ): Promise<{ succeeded: true; text: string } | { succeeded: false; failure: string }> {
    const session = record.session;
    if (!session) return { succeeded: false, failure: retryFailureText(initialFailure) };

    // 再送予算は突入時の family で固定する（途中で文言が変わっても予算は変えない）。
    const family = classifyRetryFailureFamily(initialFailure);
    if (family !== "stream" && family !== "transient") {
      return { succeeded: false, failure: retryFailureText(initialFailure) };
    }
    const maxAttempts = family === "transient" ? settings.transientMaxAttempts : settings.maxAttempts;
    // 進捗リセットで更新し得るため let（下記 resetOnProgress を参照）。
    let startedAt = Date.now();
    const elapsedExceeded = (): boolean =>
      settings.maxElapsedMs > 0 && Date.now() - startedAt >= settings.maxElapsedMs;

    let lastFailure = retryFailureText(initialFailure);
    // 進捗リセットの累計回数。MAX_PROGRESS_RESETS で頭打ちにして、
    // 「1ターンだけ進んでは切断を永遠に繰り返す」経路でも確実に終わらせる。
    let progressResets = 0;
    console.warn(
      `[pi-subagents] Retrying ${family} failure (attempt 1/${maxAttempts}): ${retryFailureHeadline(lastFailure)}`,
    );
    for (let attempt = 2; attempt <= maxAttempts; attempt++) {
      if (isAgentStopped(record) || record.abortController?.signal.aborted || parentSignal?.aborted) {
        return { succeeded: false, failure: lastFailure };
      }
      if (elapsedExceeded()) break;
      // parentSignal と record 側のどちらかが abort されたら即 resolve（最大60秒の
      // ブロッキングを避ける）。sleep 後のガードは残す（resolve 後に abort の場合）。
      await sleepAbortableMs(
        family === "transient" ? transientRetryDelayMs(settings, attempt) : settings.baseDelayMs,
        [parentSignal, record.abortController?.signal],
      );
      if (isAgentStopped(record) || record.abortController?.signal.aborted || parentSignal?.aborted) {
        return { succeeded: false, failure: lastFailure };
      }
      if (elapsedExceeded()) break;

      // この再送に入る前にどこまで会話が「実質的に」進んでいたか。resumeAgent が
      // また切れて戻ってきた時点で成功ターン数か toolUses が増えていれば、その
      // 切断は「単発」であって連続故障ではない — 長時間動くサブエージェントが
      // VPN 回転等で10分おきに切れても、その間に作業が進んでいる限り通算予算
      // で打ち切らない。
      // Note: 素の messages.length は使わない。失敗した resumeAgent 呼び出し
      // 自体がエラー応答（stopReason: "error"）を push するため、1ミリも
      // 前進していない連続失敗でも増えてしまい、無限ループになる。成功
      // assistant ターンのみを数える（countSuccessfulAssistantTurns）。
      const prevSuccessTurns = countSuccessfulAssistantTurns(session.messages);
      const prevToolUses = record.toolUses;
      const resetOnProgress = () => {
        if (progressResets >= MAX_PROGRESS_RESETS) return;
        if (
          countSuccessfulAssistantTurns(session.messages) <= prevSuccessTurns &&
          record.toolUses <= prevToolUses
        ) return;
        console.warn(
          `[pi-subagents] Conversation advanced before this ${family} failure; resetting the retry budget.`,
        );
        // attempt = 1 に戻せば次のループで attempt = 2 から再開する。
        attempt = 1;
        startedAt = Date.now();
        progressResets++;
      };

      try {
        // リトライ時は元プロンプトではなく、エラー内容を含んだ継続指示を送る。
        // これにより「同じプロンプトが再送される」問題を防ぎ、かつエージェントに
        // 「途中で切れた、続けて」という文脈を伝える。ユーザーからは、裏で steer 相当の
        // 再送が走って会話が継続する (「メッセージ送信で自動再開」) ように見える。
        // 冪等性の注意: 完了済みの tool 実行はセッション履歴に残るため再実行されないが、
        // 切断時に実行中だった tool はサーバ側で実行済みの可能性があり、再開ターンで
        // モデルが重複実行することがある。非冪等な操作の扱いはモデルの判断に委ねられる。
        // 長い cause チェーンで再送プロンプトが肥大化しないよう 200 字に截断。
        const failureSnippet = lastFailure.slice(0, 200);
        const retryPrompt = family === "transient"
          ? `（通信が切断されました。エラー: ${failureSnippet}）\n続きを進めてください。`
          : `（ストリーム接続が切れました。エラー: ${failureSnippet}）\n続きを進めてください。`;
        const result = await resumeAgent(session, retryPrompt, {
          signal: record.abortController?.signal,
          onToolActivity: (activity) => {
            if (activity.type === "end") record.toolUses++;
            options.onToolActivity?.(activity);
          },
          onAssistantUsage: (usage) => {
            addUsage(record.lifetimeUsage, usage);
            this.onUsage?.(record, usage);
            options.onAssistantUsage?.(usage);
          },
          onCompaction: (info) => {
            record.compactionCount++;
            this.onCompact?.(record, info);
            options.onCompaction?.(info);
          },
        });
        if (!result.failure) {
          record.status = "completed";
          record.error = undefined;
          record.result = result.text;
          record.completedAt = Date.now();
          this.abortOwnedChildren(record.id);
          return { succeeded: true, text: result.text };
        }
        lastFailure = result.failure;
        // 429 系・上流到達不能はリトライを打ち切る（同一モデルで粘らない）。
        // フォールバックは runAgent の役目であり、ここでは回数消費だけになるため。
        const nextFamily = classifyRetryFailureFamily(result.failure);
        if (nextFamily === "usage-limit" || nextFamily === "upstream") {
          console.warn(`[pi-subagents] Stopping retry: failure changed to ${nextFamily}; leaving it to the model fallback chain.`);
          record.error = lastFailure;
          return { succeeded: false, failure: lastFailure };
        }
        if (nextFamily !== "stream" && nextFamily !== "transient") break;
        resetOnProgress();
      } catch (error) {
        lastFailure = retryFailureText(error);
        // throw されたエラーも同様：429 系・502 系ならリトライを打ち切る。
        const caughtFamily = classifyRetryFailureFamily(error);
        if (caughtFamily === "usage-limit" || caughtFamily === "upstream") {
          console.warn(`[pi-subagents] Stopping retry: failure changed to ${caughtFamily}; leaving it to the model fallback chain.`);
          record.error = lastFailure;
          return { succeeded: false, failure: lastFailure };
        }
        if (caughtFamily !== "stream" && caughtFamily !== "transient") break;
        // catch 側も同じ判定：進捗があれば予算をリセットする。
        resetOnProgress();
      }
    }

    // 回数切れと時間切れを区別してログ出す（同じ文言だと原因切り分けができない）。
    if (elapsedExceeded()) {
      console.warn(
        `[pi-subagents] Giving up retry after exceeding the ${family} time budget (${settings.maxElapsedMs}ms): ${retryFailureHeadline(lastFailure)}`,
      );
    } else {
      console.warn(
        `[pi-subagents] Giving up retry after exceeding the ${family} attempt budget (${maxAttempts} attempts): ${retryFailureHeadline(lastFailure)}`,
      );
    }
    record.error = lastFailure;
    return { succeeded: false, failure: lastFailure };
  }

  /**
   * The shared tail of the two SUCCESS settle paths (normal completion and
   * retry-recovered): flush the transcript, clean up the worktree with its
   * branch note, release the pool slot and notify. The error tail stays
   * separate — it settles `false`, skips the hook and the branch note.
   *
   * A `cleanupWorktree` throw propagates, exactly as the normal path always
   * did; the retry-recovered caller wraps this in try/catch to keep its
   * historical swallow. Neither this helper nor its callers touch the model
   * fallback chain — that lives in runAgent and the `isUsageLimitError` gate
   * above, both outside this tail.
   */
  private async settleSpawnSuccess(
    record: AgentRecord,
    ctx: {
      id: string;
      pi: ExtensionAPI;
      baseCwd: string;
      customCwd: string | undefined;
      options: Pick<SpawnOptions, "description" | "onBeforeWorktreeCleanup">;
      holdsSlot: boolean;
    },
  ): Promise<void> {
    // Final flush of streaming output file
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore */ }
      record.outputCleanup = undefined;
    }

    // Clean up worktree if used
    if (record.worktree) {
      // The one moment the child's tree still exists and the child is done
      // writing to it. try/catch, not decoration: a hook that throws must
      // not leave the worktree behind.
      if (ctx.options.onBeforeWorktreeCleanup) {
        try {
          await ctx.options.onBeforeWorktreeCleanup(record.worktree.path);
        } catch { /* ignore — never block cleanup */ }
      }
      const wtResult = await cleanupWorktree(ctx.pi, ctx.baseCwd, record.worktree, ctx.options.description);
      record.worktreeResult = wtResult;
      if (wtResult.hasChanges && wtResult.branch) {
        // With a caller-supplied cwd the branch lives in THAT repo, not the
        // parent session's — say so, or the orchestrator merges in the wrong repo.
        const repoNote = ctx.customCwd !== undefined ? ` in \`${ctx.baseCwd}\`` : "";
        // Appended to the prose only. A structured child's caller parses
        // `structuredJson`, which stays untouched — but `result` is also
        // what a human reads, so the note still belongs on it.
        record.result = (record.result ?? "") +
          `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${ctx.customCwd !== undefined ? ` (run in \`${ctx.baseCwd}\`)` : ""}`;
      }
    }

    this.abortOwnedChildren(ctx.id);

    this.settleRun(record, true, ctx.holdsSlot);
  }

  /**
   * The shared tail of both settle paths: release whatever pool slot the run
   * held, notify, and let the queue drain into the freed slot.
   *
   * The decrement lives HERE and nowhere else. `abort()` on a running record
   * only fires its controller and leaves the run to settle normally, so
   * decrementing there too would double-free — permanently lifting the limit.
   *
   * Inline spawns (`isBackground: false`) fire `onComplete` for lifecycle
   * symmetry, with `resultConsumed` set so the callback skips notifications the
   * inline result already delivered.
   *
   * @param guardCallback swallow a throwing `onComplete` (the success path does;
   *   the error path historically did not, and keeps not doing so).
   * @param holdsSlot whether this run was CHARGED TO the pool at start time —
   *   passed in, not recomputed, so a mid-run change to `maxConcurrent` can't
   *   make the release disagree with the acquire.
   */
  private settleRun(record: AgentRecord, guardCallback: boolean, holdsSlot: boolean): void {
    if (!record.isBackground) record.resultConsumed = true;
    if (holdsSlot) this.runningBackground--;

    if (guardCallback) {
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
    } else {
      this.onComplete?.(record);
    }

    // Only a freed slot can have made room for a queued agent; anything else
    // would be a drain with nothing to do.
    if (holdsSlot) this.drainQueue();
  }

  /**
   * Stop the nested children a settled parent owns. Nested records are hidden
   * from the UI and only their owner can consume them, so a child outliving its
   * parent would burn tokens unseen with no way to reach it. Grandchildren are
   * covered transitively — each abort lands in that child's own settle path.
   */
  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.agents) {
      if (record.parentAgentId === parentId) this.abort(id);
    }
  }

  /**
   * Start queued agents while a concurrency slot is free. FIFO: the queue has a
   * single pool, so the head is always the earliest entry that can go.
   */
  private drainQueue() {
    for (;;) {
      if (!this.poolHasRoom()) return;
      const next = this.queue.shift();
      if (next === undefined) return;
      const record = this.agents.get(next.id);
      // Stale entries (aborted while queued) are not started.
      if (!record || record.status !== "queued") continue;
      // Detached, and never rejects: a late failure (e.g. strict worktree
      // isolation) lands on the record inside `launch`, exactly as the
      // synchronous throw did here before, and draining continues either way.
      void next.start();
    }
  }

  /** Drop queued entries. */
  private dequeue(pred: (entry: { id: string }) => boolean): void {
    this.queue = this.queue.filter(e => !pred(e));
  }

  /**
   * Spawn an agent and block the caller until it finishes.
   *
   * INTERNAL — the `Agent` tool never reaches it: every spawn a model asks for
   * is detached, so a top-level call always returns an id and delivers its
   * result through the completion notification. What is left is the callers
   * that genuinely have to answer inline: nested delegation (a detached child
   * is killed by `abortOwnedChildren` when its parent settles, and has no
   * notification path of its own), a workflow's `agent()`, and the
   * `/agents → Create agent` generator.
   *
   * Takes no concurrency slot and never queues: its spawn is not a detached
   * top-level one (see `occupiesPoolSlot`), so a parent blocked awaiting its
   * own child can neither starve nor deadlock the pool.
   *
   * @param onSpawned - Called synchronously once the run is kicked off, before
   *   onSessionCreated fires. Use this to set record.outputFile so
   *   streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    const id = this.spawn(pi, ctx, type, prompt, {
      ...options,
      isBackground: false,
      onSpawned,
    });
    const record = this.agents.get(id)!;

    // The run promise only exists once startup is past its awaited repo copy —
    // without this the call would return before the agent had started at all.
    // A startup failure (strict worktree isolation) rejects here, which is what
    // the caller path owes it: pi only marks a tool result failed when
    // `execute` throws.
    await this.awaitStartup(id);

    // undefined when it was aborted while queued, or stopped mid-copy, and so
    // never ran — the record is already terminal with a completedAt, which is
    // what the caller renders.
    if (record.promise) await record.promise;

    // A record that ended "error" without ever getting a promise never ran: the
    // same startup failure spawn() rethrows on the immediate path (#179). Keep
    // one contract rather than letting anything else decide whether a strict
    // worktree failure throws or returns as a result.
    if (record.promise === undefined && record.status === "error") {
      throw new Error(record.error ?? "Agent failed to start");
    }
    return { id, record };
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;

    // Background resume: settle asynchronously and notify on completion exactly
    // like a background spawn, returning immediately with the record still
    // "running" — or "queued" when at the concurrency limit. Without it the
    // resume runs inline and only settles when the caller is handed the
    // finished record.
    if (options?.isBackground) {
      // Never re-enter a run that is still in flight. Detaching means the caller
      // gets control back while the record stays "running", so nothing stops the
      // model from resuming the same agent again. Starting a second run would
      // overwrite record.abortController — orphaning the live run beyond the
      // reach of `/agents` stop and abortAll() — double-count the pool slot, and
      // then reject from session.prompt() with "Agent is already processing",
      // whose settle path would abort the LIVE run's children and report a
      // failure for a run that is still going. Refuse instead, leaving the
      // record untouched; the caller decides whether to wait or steer.
      if (record.status === "running" || record.status === "queued") return undefined;

      record.isBackground = true;
      record.resultConsumed = false;
      record.result = undefined;
      record.error = undefined;
      record.completedAt = undefined;
      record.status = "queued";

      const start = () => this.startResume(id, record, prompt, signal, options);
      if (occupiesPoolSlot(record) && !this.poolHasRoom()) {
        // At the concurrency limit — queue it, drains when a slot frees. A
        // detached resume has no inline caller. The queue is shared with
        // spawns, whose startup is async, so entries are promise-shaped even
        // though a resume starts synchronously; failures land on the record
        // here, since drainQueue no longer catches.
        this.queue.push({
          id,
          start: async () => {
            try {
              start();
            } catch (err) {
              record.status = "error";
              record.error = err instanceof Error ? err.message : String(err);
              record.completedAt = Date.now();
              this.onComplete?.(record);
            }
          },
        });
      } else {
        start();
      }
      return record;
    }

    // Inline resume: run it and return the settled record.
    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;

    // startResume と同じ: spawn と同じゲート（shouldRetry に一本化）で切断を
    // 自動再送する。設定は spawn 時と同じ configCwd から読む。structuredOutput
    // は resume に無いため {} 相当。
    const retrySettings = loadSubagentsRetrySettings(record.configCwd);
    const retryOptions: SpawnOptions = {
      description: record.description,
      onToolActivity: options?.onToolActivity,
      onAssistantUsage: options?.onAssistantUsage,
      onCompaction: options?.onCompaction,
    };

    try {
      const { text, failure } = await resumeAgent(record.session, prompt, {
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
          options?.onToolActivity?.(activity);
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
          this.onUsage?.(record, usage);
          options?.onAssistantUsage?.(usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
          options?.onCompaction?.(info);
        },
        signal,
      });
      let finalText = text;
      let finalFailure = failure;
      // spawn の .then と同じゲート。429 系はリトライ対象外。
      if (shouldRetry(failure, retrySettings, record, {})) {
        const retryResult = await this.retryStreamFailure(record, retrySettings, signal, failure, retryOptions);
        if (retryResult.succeeded) {
          finalText = retryResult.text;
          finalFailure = undefined;
        } else {
          finalFailure = retryResult.failure;
        }
      }
      // Same contract as the spawn path (#144): a failed final turn is an
      // error, not a completion — but the resumed text stays available.
      record.status = finalFailure ? "error" : "completed";
      if (finalFailure) record.error = finalFailure;
      record.result = finalText;
      record.completedAt = Date.now();
    } catch (err) {
      let finalErr: unknown = err;
      // spawn の .catch と同じゲート（shouldRetry に一本化）。429 系は対象外。
      if (shouldRetry(err, retrySettings, record, {})) {
        const retryResult = await this.retryStreamFailure(record, retrySettings, signal, err, retryOptions);
        if (retryResult.succeeded) {
          // spawn の .catch と同じ成功 tail: そのまま完了として定着させ、
          // 下の共通 tail（abortOwnedChildren + return）を先に通して抜ける。
          record.status = "completed";
          record.error = undefined;
          record.result = retryResult.text;
          record.completedAt = Date.now();
          this.abortOwnedChildren(id);
          return record;
        }
        finalErr = new Error(retryResult.failure);
      }
      record.status = "error";
      record.error = finalErr instanceof Error ? finalErr.message : String(finalErr);
      record.completedAt = Date.now();
    }

    // Same contract as the spawn settle paths: children spawned during the
    // resumed turn must not outlive it — nothing else can see or reach them.
    this.abortOwnedChildren(id);

    return record;
  }

  /**
   * Start a background resume run: detached, settling and notifying like
   * startAgent's background path. Invoked immediately, or from drainQueue when
   * a concurrency slot frees. The session already exists (resume reuses it), so
   * there is no onSessionCreated to hang per-run wiring off — callers use
   * `options.onStarted`, which fires on both the immediate and the drained path.
   */
  private startResume(
    id: string,
    record: AgentRecord,
    prompt: string,
    parentSignal: AbortSignal | undefined,
    options: ResumeOptions,
  ) {
    if (!record.session) return;

    record.status = "running";
    record.startedAt = Date.now();
    if (occupiesPoolSlot(record)) this.runningBackground++;
    this.onStart?.(record);

    // Fresh abort controller so /agents stop and steering target THIS run rather
    // than the previous one's settled controller.
    const abortController = new AbortController();
    record.abortController = abortController;
    // Optional, and NOT what the Agent tool passes for a detached resume: a
    // parent signal aborts on the parent's own interrupt (user Esc), which is
    // right for a run whose result the caller is awaiting, and wrong for a
    // detached one — background spawns omit it for exactly this reason.
    let detachParentSignal: (() => void) | undefined;
    if (parentSignal) {
      const onParentAbort = () => this.abort(id);
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
    }

    // Per-run side effects (output streaming) — see ResumeOptions.onStarted.
    // After the record is in its running shape, before the run is kicked off.
    try { options.onStarted?.(); } catch { /* ignore caller wiring errors */ }

    const settle = () => {
      detachParentSignal?.();
      detachParentSignal = undefined;
      // Final flush of streaming output file
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }
      // Children spawned during the resumed turn must not outlive it.
      this.abortOwnedChildren(id);
      if (occupiesPoolSlot(record)) this.runningBackground--;
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      this.drainQueue();
    };

    // spawn と同じゲート（shouldRetry に一本化）: resume 経路でもストリーム切断を
    // 自動再送する。設定は spawn 時と同じ configCwd から読む（this.cwd は存在
    // しないため record.configCwd を使う）。structuredOutput は resume に無い
    // ため {} 相当。
    const retrySettings = loadSubagentsRetrySettings(record.configCwd);
    // retryStreamFailure は SpawnOptions のコールバックだけを読む。resume 側の
    // 同じコールバックを渡しておく（{} だと再送ターンの進捗が UI に届かない）。
    const retryOptions: SpawnOptions = {
      description: record.description,
      onToolActivity: options.onToolActivity,
      onAssistantUsage: options.onAssistantUsage,
      onCompaction: options.onCompaction,
    };

    const promise = resumeAgent(record.session, prompt, {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      signal: abortController.signal,
    })
      .then(async ({ text, failure }) => {
        let finalText = text;
        let finalFailure = failure;
        // spawn の .then と同じゲート。429 系はリトライ対象外。
        if (shouldRetry(failure, retrySettings, record, {})) {
          const retryResult = await this.retryStreamFailure(record, retrySettings, parentSignal, failure, retryOptions);
          if (retryResult.succeeded) {
            finalText = retryResult.text;
            finalFailure = undefined;
          } else {
            finalFailure = retryResult.failure;
          }
        }
        // Don't overwrite status if externally stopped via abort().
        if (record.status !== "stopped") {
          // Same contract as the spawn path (#144): a failed final turn is an
          // error, not a completion — but the resumed text stays available.
          record.status = finalFailure ? "error" : "completed";
          if (finalFailure) record.error = finalFailure;
        }
        record.result = finalText;
        record.completedAt ??= Date.now();
        settle();
        return finalText;
      })
      .catch(async (err) => {
        let finalErr: unknown = err;
        // .then 側と同じゲート（shouldRetry に一本化）。429 系はリトライ対象外。
        if (shouldRetry(err, retrySettings, record, {})) {
          const retryResult = await this.retryStreamFailure(record, retrySettings, parentSignal, err, retryOptions);
          if (retryResult.succeeded) {
            // spawn の .catch と同じ成功 tail: そのまま完了として定着させる。
            record.status = "completed";
            record.error = undefined;
            record.result = retryResult.text;
            record.completedAt ??= Date.now();
            settle();
            return record.result ?? "";
          }
          finalErr = new Error(retryResult.failure);
        }
        if (record.status !== "stopped") {
          record.status = "error";
          record.error = finalErr instanceof Error ? finalErr.message : String(finalErr);
        }
        record.completedAt ??= Date.now();
        settle();
        return "";
      });

    record.promise = promise;
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /**
   * Resolve an agent by exact id, handle/alias, or unique id prefix.
   * Lets callers resume with a short id (e.g. first 8-16 chars from a
   * notification) instead of the full UUID. Returns undefined when there
   * is no match or the prefix is ambiguous.
   *
   * id prefix は最低6文字を要求する（1文字解決の誤爆防止）。disk 側
   * findSessionOnDisk の ID prefix 側も6文字（hashPart 側は4文字）、stop 側の
   * 文書は 8+ 文字推奨のため、6文字 floor はどちらとも整合する。
   * handle/alias 照合には floor を掛けない（短い名前は正規の指定のため）。
   */
  resolveRecord(id: string): AgentRecord | undefined {
    const exact = this.agents.get(id);
    if (exact) return exact;
    const wanted = id.toLowerCase();
    for (const record of this.agents.values()) {
      if (record.handle?.toLowerCase() === wanted || record.alias?.toLowerCase() === wanted) {
        return record;
      }
    }
    // 短すぎる prefix は曖昧さ以前に受け付けない（空文字の1件ヒット等を防ぐ）。
    if (wanted.length < MIN_ID_PREFIX_LEN) return undefined;
    let match: AgentRecord | undefined;
    for (const record of this.agents.values()) {
      if (record.id.toLowerCase().startsWith(wanted)) {
        if (match) return undefined; // ambiguous
        match = record;
      }
    }
    return match;
  }

  /** Handles already in use, so a fresh spawn can pick an unclaimed one. */
  private takenHandles(): Set<string> {
    const taken = new Set<string>();
    for (const record of this.agents.values()) {
      if (record.handle) taken.add(record.handle);
      if (record.alias) taken.add(record.alias);
    }
    return taken;
  }

  /**
   * Resolve an `@name` from the prompt. Matches a top-level agent's handle
   * case-insensitively, preferring one that can still be steered and otherwise
   * the most recently started (which is the one a resume should continue), then
   * falls back to an exact agent id so `@<agentId>` works too.
   *
   * An id also matches by a unique prefix (≥ {@link MIN_ID_PREFIX_LEN} chars),
   * the same rule `resolveRecord` and the on-disk session search apply, so a
   * short id from a completion notification names the same agent everywhere.
   * Ambiguous prefixes are refused rather than guessed.
   */
  resolveMention(name: string): MentionResolution | undefined {
    const wanted = name.toLowerCase();
    let fallback: AgentRecord | undefined;
    for (const record of this.agents.values()) {
      if (record.parentAgentId !== undefined) continue;
      // Handle and alias share one namespace, so at most one agent answers a
      // name and it makes no difference which of the two matched.
      if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
      if (record.status === "running" || record.status === "queued") return { kind: "live", record };
      if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
    }
    if (fallback) return { kind: "live", record: fallback };
    const byId = this.agents.get(name);
    if (byId?.parentAgentId === undefined && byId !== undefined) return { kind: "live", record: byId };
    if (wanted.length < MIN_ID_PREFIX_LEN) return undefined;
    let match: AgentRecord | undefined;
    for (const record of this.agents.values()) {
      // Nested children have no handle and are not addressable from a top-level
      // surface, so a prefix that happens to hit one must not resolve to it.
      if (record.parentAgentId !== undefined) continue;
      if (record.id.toLowerCase().startsWith(wanted)) {
        if (match) return undefined; // ambiguous
        match = record;
      }
    }
    return match ? { kind: "live", record: match } : undefined;
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued. No decrement — the slot was never taken —
    // and no onComplete, matching what a queued background abort has always
    // done; a blocking caller learns of the stop from its own tool result.
    if (record.status === "queued") {
      this.dequeue(q => q.id === id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /**
   * Dispose a record's session and remove it from the map.
   *
   * Nothing is preserved here: the conversation already lives on disk (the pi
   * session file, its `archive/` sibling after 24h idle, and the `.output`
   * transcript), so a resume that arrives later reopens it from there rather
   * than from a second in-memory copy of the same bookkeeping.
   */
  private removeRecord(id: string, record: AgentRecord): void {
    // The record is the last holder of its ToDo store — anything still keyed by
    // this handle/id has nothing left to report into.
    dropNestedTodos(record.handle ?? record.id);
    const session = record.session;
    // Detached before the shutdown starts, so the record leaves the map at once and
    // nothing can observe a session that is half torn down.
    record.session = undefined;
    this.agents.delete(id);
    // A failed startup keeps its (rejected) entry so a late awaitStartup still
    // sees it; drop it with the record so the map can't grow unbounded.
    this.startups.delete(id);
    // Fire-and-forget is right here and only here: this runs from the 60s cleanup timer
    // and from `clearCompleted()` on session boundaries, with the process staying alive,
    // so handlers get their full window. The quit path awaits instead — see dispose().
    void shutdownChildSession(session);
  }

  /**
   * Release a finished record's live session object while keeping the record.
   *
   * The session is the expensive half of a finished agent (extension runner,
   * full message array, stream subscriptions); the record is a few fields.
   * Dropping the session at ten minutes bounds what an idle session costs,
   * and loses nothing: `record.sessionFile` / `record.outputFile` still name
   * the conversation, which is what a resume reopens.
   */
  private detachSession(record: AgentRecord): void {
    const session = record.session;
    record.session = undefined;
    void shutdownChildSession(session);
  }

  /**
   * Two memory bounds on finished records, on the minute:
   *
   *   - past {@link SESSION_DETACH_AFTER_MS}, the live session object is shut
   *     down and detached. The record stays — it is cheap and still answers
   *     `@handle`, steering and resumes — and reopening happens from
   *     `record.sessionFile` / `record.outputFile`.
   *   - past {@link RECORD_RETAIN_MS}, the record itself goes. By then the
   *     conversation has been on disk for a day and archiving owns it; a later
   *     resume finds the `.jsonl` (live or under `archive/`) or rebuilds one
   *     from the `.output` transcript.
   *
   * Running and queued records are never touched, however old they look: a
   * live agent's session being disposed mid-run is the worst failure this
   * guard prevents, and `completedAt` on a running record is meaningless.
   */
  private cleanup() {
    const now = Date.now();
    const detachCutoff = now - SESSION_DETACH_AFTER_MS;
    const retainCutoff = now - RECORD_RETAIN_MS;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      const completedAt = record.completedAt ?? 0;
      if (completedAt >= retainCutoff) {
        // Guarded on the session itself, not just the age: a detached record
        // keeps being visited every minute for 24 hours, and `detachSession`
        // would call shutdownChildSession(undefined) each time for nothing.
        if (record.session && completedAt < detachCutoff) this.detachSession(record);
        continue;
      }
      this.removeRecord(id, record);
    }
  }

  /**
   * Drop every finished record from memory now. Both callers are session
   * boundaries (`session_start`, `session_before_switch`): the next session has
   * its own agents, so carrying these across would only leak their names and
   * bookkeeping into it. Nothing is lost — each conversation is already on disk
   * (`.jsonl`, `archive/` after 24h idle, `.output` transcript), and a resume
   * by id, handle or alias reopens it from there.
   *
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false); the cleanup timer will reap them instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.dequeue(() => true);
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending: Promise<unknown>[] = [];
      for (const record of this.agents.values()) {
        if (record.status !== "running" && record.status !== "queued") continue;
        // An agent whose worktree is still being created is "running" with no
        // `promise` yet — without its startup the wait would return too early.
        const startup = this.startups.get(record.id);
        if (startup) pending.push(startup);
        if (record.promise) pending.push(record.promise);
      }
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  /**
   * @param pi - Needed to run `git worktree prune`, which is async now and so
   *   cannot be reached through a stored spawn argument at shutdown. Omitting
   *   it (tests, teardown of a manager that never spawned) skips the prune.
   */
  async dispose(pi?: ExtensionAPI): Promise<void> {
    clearInterval(this.cleanupInterval);
    // Clear queue: nothing left queued is ever started once the manager is gone.
    this.dequeue(() => true);
    const sessions = [...this.agents.values()].map(record => record.session);
    this.agents.clear();
    this.startups.clear();
    if (pi) {
      // Prune any orphaned git worktrees (crash recovery). Detached: dispose runs
      // on the shutdown path, which cannot wait for git. Started before the awaited
      // shutdown below rather than after it, so the git calls have that window to
      // finish in instead of racing the process exit that follows.
      const prune = (repo: string) => { pruneWorktrees(pi, repo).catch(() => {}); };
      prune(process.cwd());
      // Also prune repos that caller-supplied cwds created worktrees in — a clean
      // exit with in-flight agents would otherwise leave stale registrations there.
      for (const repo of this.worktreeRepos) prune(repo);
    }
    // Awaited, unlike the eviction path: pi awaits this extension's `session_shutdown`
    // handler and the process exits right after it returns, so anything left unawaited
    // here never runs at all. Bounded — each call carries its own ceiling, concurrently.
    await Promise.all(sessions.map(session => shutdownChildSession(session)));
  }
}
