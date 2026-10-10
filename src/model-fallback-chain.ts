/**
 * model-fallback-chain.ts — カンマ区切りのモデルフォールバック連鎖と使用制限エラーの判定。
 *
 * 記法: model 欄に `provider/modelA, provider/modelB` と書くと、先頭がプライマリ、
 * 後続がフォールバック先になる。カンマ無しは従来通り単一モデル（フォールバック動作なし）。
 */

 /**
  * モデル連鎖をパースする。カンマ分割＋trim＋空除去のみ。クォート対応は不要。
  * 空入力は [] を返す（呼び出し側は「指定なし」として扱う）。
  */
export function parseModelChain(input: string): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

/**
 * 使用制限エラーの「はっきり」判定。陽性リスト方式のみ——ここに該当すれば true。
 *
 * 方針（迷うものは入れない）: 429・quota 系は文言が紛らわしいものが多い
 * （例: リトライ可能扱いの "upstream execution failed" に 429 が包まれる場合、
 * 混雑系の "overloaded"、単なる "quota" の言及）ため、以下に列挙した
 * 「使用制限と断定できる」パターンだけを陽性とする。該当しない曖昧なエラーでは
 * フォールバックせず、従来のエラー扱い（stream リトライ判定に委ねる）に留める。
 * 上流到達不能（502 系・unreachable 系）だけは別関数 isUpstreamUnreachableError が
 * 拾い、classifyRetryFailure 上は同じ "fallback" 扱いにする。
 *
 * auth枯渇を示す文言（使用制限の一部。同一モデル継続の緩和判定にも使う）。
 */
const AUTH_UNAVAILABLE_PATTERNS: RegExp[] = [
  // 実測文言: "503: {\"message\":\"auth_unavailable: no auth available
  // (providers=openai-compatible-cline, model=cline-muse-spark-1.3; ...)\"}"。
  // 認証枯渇は回復待ちではなく別モデルへ降ろす対象のため、使用制限扱いとする。
  // 小文字化後に判定されるため小文字で書く。
  /auth[\s_-]*unavailable/,
  /no[\s_-]*auth[\s_-]*available/,
];

const USAGE_LIMIT_PATTERNS: RegExp[] = [
  // 独立した 429 ステータス（"status 429" / "HTTP 429" 等）。
  // 数字境界で囲む — "529" や "14290" のような別番号に誤爆させないため。
  /(^|[^0-9])429([^0-9]|$)/,
  // 実測文言: "You've hit the hourly free allowance for gpt-5.6-luna"。
  // hourly/daily 等の期間違いを吸収するため "free allowance" で判定する。
  /free allowance/,
  // "rate limit" / "rate_limit" / "ratelimit" / "RateLimitExceeded" 等。
  /rate[\s_-]*limit/,
  // OpenAI 系の quota エラー。"insufficient_quota" と "quota exceeded" のみ。
  // 素の "quota" 単独は対象外（"quota info" のような無害な言及があり得るため）。
  /insufficient[\s_]*quota/,
  /quota[\s_-]*exceeded/,
  // "usage limit" / "usage_limit"。
  /usage[\s_-]*limit/,
  // auth枯渇は使用制限扱い（実測文言の注釈は AUTH_UNAVAILABLE_PATTERNS 側）。
  ...AUTH_UNAVAILABLE_PATTERNS,
  // NOTE: "overloaded" は意図的に対象外。混雑は回復待ち系であり、
  // 使用制限（quota 枯渇）とは別扱いのため含めない。
  // NOTE: 500 系・"too many requests"・"reached your quota" 等の紛らわしい
  // 文言も含めない。必要になれば実測文言を添えてここに1行ずつ追加する。
  // ただし 502/503/504・"upstream unreachable" 等の上流到達不能は
  // isUsageLimitError ではなく isUpstreamUnreachableError 側で拾う。
];

/** `status: 429` のように数値フィールドで持つエラー形状も拾うキー。 */
const STATUS_KEYS = ["status", "statusCode", "status_code", "code"] as const;

/** 非 Error オブジェクトの message 保持キー。 */
const MESSAGE_KEYS = ["message"] as const;

/** 使用制限エラー（429・quota・rate limit 系）と断定できる場合のみ true。 */
export function isUsageLimitError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  // 数値ステータスを直接持つ形状（{ status: 429 } 等）は文言によらず確定。
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of STATUS_KEYS) {
      const value = record[key];
      if (value === 429 || value === "429") return true;
    }
    // Error オブジェクトは下のメッセージ判定へ進む。
    if (!(error instanceof Error)) {
      // 非 Error オブジェクトは message 文字列だけを見る（String(obj) は
      // "[object Object]" になるため）。文字列でなければ対象外。
      const texts = MESSAGE_KEYS.map(key => record[key]).filter((value): value is string => typeof value === "string");
      if (texts.length === 0) return false;
      const normalized = texts.join("\n").toLowerCase();
      return USAGE_LIMIT_PATTERNS.some(pattern => pattern.test(normalized));
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return false;
  const normalized = message.toLowerCase();
  return USAGE_LIMIT_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * サーバー要求の待機がフォールバックへ降りる境界（30分 = 1800秒）。
 * この秒数以下はフォーク側の設定時間で同一モデル再送し、超えたら使用制限扱いで
 * フォールバックへ降ろす。サーバーの指示時間そのものでは待たない。
 */
export const RETRY_DELAY_FALLBACK_THRESHOLD_S = 1800;

/**
 * failure 文字列からサーバー要求のリトライ待機秒数を返す。含まれなければ undefined。
 *
 * 実測文言: "Server requested 21555s retry delay (max: 12s). 503 ..."。
 * 優先順位が重要 — "(max: 12s)" のような付随秒数を誤って拾わないよう、
 * 要求側（server requested / 数値+s+retry delay）を先に試し、"retry delay ... 秒数"
 * や "retry-after" 系は後に試す。単位付き retry-after（ms/m/h）は秒に換算する。
 */
const RETRY_DELAY_PATTERNS: RegExp[] = [
  // "Server requested 21555s retry delay"（実測形）。
  /server\s+requested\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\s+retry\s*delay/i,
  // 汎用: "21555s retry delay"（数値が前）。
  /(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\s+retry\s*delay/i,
  // 汎用: "retry delay of 300s" / "retry delay: 300 seconds"（数値が後）。
  /retry\s*delay[^\d]{1,40}?(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?\b/i,
  // retry-after 系: "retry-after: 120" / "retry after 5 minutes"。単位換算あり。
  /retry[-\s_]*after[^\d]{0,16}(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)?/i,
];

/** retry-after 系の単位を秒へ換算する。単位なし（ヘッダ秒数）は秒扱い。 */
function retryAfterToSeconds(value: number, unit: string | undefined): number {
  const u = (unit ?? "s").toLowerCase();
  if (u === "ms" || u === "msec" || u === "msecs" || u === "millisecond" || u === "milliseconds") return value / 1000;
  if (u === "m" || u === "min" || u === "mins" || u === "minute" || u === "minutes") return value * 60;
  if (u === "h" || u === "hr" || u === "hrs" || u === "hour" || u === "hours") return value * 3600;
  return value;
}

export function parseRetryDelaySeconds(input: unknown): number | undefined {
  let raw: string;
  if (typeof input === "string") {
    raw = input;
  } else if (input instanceof Error) {
    raw = input.message;
  } else if (typeof input === "object" && input !== null && typeof (input as Record<string, unknown>).message === "string") {
    raw = (input as Record<string, unknown>).message as string;
  } else {
    return undefined;
  }
  if (!raw) return undefined;
  for (let i = 0; i < RETRY_DELAY_PATTERNS.length; i++) {
    const match = RETRY_DELAY_PATTERNS[i].exec(raw);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    // 最後（retry-after 系）のみ単位換算する。
    if (i === RETRY_DELAY_PATTERNS.length - 1) return retryAfterToSeconds(value, match[2]);
    return value;
  }
  return undefined;
}

/** auth枯渇（auth_unavailable / no auth available）なら true。同一モデル継続の緩和判定用。 */
export function isAuthUnavailable(input: unknown): boolean {
  let raw: string;
  if (typeof input === "string") {
    raw = input;
  } else if (input instanceof Error) {
    raw = input.message;
  } else if (typeof input === "object" && input !== null && typeof (input as Record<string, unknown>).message === "string") {
    raw = (input as Record<string, unknown>).message as string;
  } else {
    return false;
  }
  if (!raw) return false;
  return AUTH_UNAVAILABLE_PATTERNS.some(pattern => pattern.test(raw.toLowerCase()));
}

/**
 * 上流到達不能（502/503/504・upstream unreachable 等）。使用制限ではないため
 * isUsageLimitError には含めないが、扱いは usage-limit と同じ「フォールバック」:
 * 同じモデルで粘っても通る見込みが薄く、confirm せず次のモデルへ降ろす対象。
 *
 * 実測文言: CPA が 502 を返した時のログ
 * `502 | upstream execution failed: provider=openai-compatible-opencode
 *  model=mimo-v2.6-flash-free err={"error":"upstream unreachable"}`
 * （書式の出所: cli-proxy-api-fork/sdk/cliproxy/auth/conductor_execution.go の
 * warnLogUpstreamFailure）。この1行の中に「502」と「upstream unreachable」の
 * 両方が出るため、どちらか一方で拾える。
 *
 * 境界の理由:
 * - 5xx を広く (5\d\d) にはしない。500 単発は従来どおり対象外
 *   （test/model-fallback-chain.test.ts の negative:
 *    "Internal Server Error (500)" / { status: 500 } は isUsageLimitError false）。
 * - 数字の前後を [^0-9a-z] で縁取る。"model=qwen-502b-free" のような
 *   モデル名の数字を誤爆させないため（英字が隣接する 502 は別語として弾く）。
 *   429 側の既存境界 (^|[^0-9])429([^0-9]|$) と同じ方針。
 * - "upstream execution failed" 単独は含めない。CPA は 502 時に必ず数字か
 *   unreachable 文言を伴うため実測カバーは同等で、この文言は RETRYABLE_STREAM_ERRORS
 *   の既存分類（stream）を維持する方が test/agent-manager-retry.test.ts の
 *   "stops after maxAttempts and preserves the final stream error" と整合する。
 * 照合は小文字化済みテキストへの部分一致のため小文字で書く。
 */
const UPSTREAM_UNREACHABLE_PATTERNS: RegExp[] = [
  // 502 Bad Gateway / 503 Service Unavailable / 504 Gateway Timeout。
  /(^|[^0-9a-z])50[234]([^0-9a-z]|$)/,
  /upstream[\s_-]*unreachable/,
  /provider[\s_-]*unreachable/,
  /bad[\s_-]*gateway/,
];

/** 上流到達不能（502 系・unreachable 系）と断定できる場合のみ true。 */
export function isUpstreamUnreachableError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  // 数値ステータスを直接持つ形状（{ status: 502 } 等）は文言によらず確定。
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of STATUS_KEYS) {
      const value = record[key];
      if (value === 502 || value === "502" || value === 503 || value === "503"
        || value === 504 || value === "504") return true;
    }
    // Error オブジェクトは下のメッセージ判定へ進む。
    if (!(error instanceof Error)) {
      const texts = MESSAGE_KEYS.map(key => record[key]).filter((value): value is string => typeof value === "string");
      if (texts.length === 0) return false;
      const normalized = texts.join("\n").toLowerCase();
      return UPSTREAM_UNREACHABLE_PATTERNS.some(pattern => pattern.test(normalized));
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return false;
  const normalized = message.toLowerCase();
  return UPSTREAM_UNREACHABLE_PATTERNS.some(pattern => pattern.test(normalized));
}

/** agent-runner の失敗分岐（テストと同一実体）。delay 付きは秒数で分岐、無ければ使用制限判定。 */
export type RetryFailureClass = "own-retry" | "fallback" | "as-is";

export function classifyRetryFailure(failure: string): RetryFailureClass {
  const delay = parseRetryDelaySeconds(failure);
  if (delay !== undefined) return delay <= RETRY_DELAY_FALLBACK_THRESHOLD_S ? "own-retry" : "fallback";
  // 使用制限と上流到達不能は同じ「次のモデルへ降りる」扱い（エージェントを放棄しない）。
  return isUsageLimitError(failure) || isUpstreamUnreachableError(failure) ? "fallback" : "as-is";
}
