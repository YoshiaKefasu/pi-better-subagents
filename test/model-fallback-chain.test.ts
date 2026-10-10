import { describe, expect, it } from "vitest";
import { classifyRetryFailure, isUsageLimitError, parseModelChain, parseRetryDelaySeconds, RETRY_DELAY_FALLBACK_THRESHOLD_S } from "../src/model-fallback-chain.js";

describe("parseModelChain", () => {
  it("splits on commas and trims entries", () => {
    expect(parseModelChain("openai/gpt-5.6-luna, anthropic/claude-sonnet-4-6 , google/gemini-2.5-pro"))
      .toEqual(["openai/gpt-5.6-luna", "anthropic/claude-sonnet-4-6", "google/gemini-2.5-pro"]);
  });

  it("returns a single entry unchanged (no fallback)", () => {
    expect(parseModelChain("anthropic/haiku")).toEqual(["anthropic/haiku"]);
  });

  it("drops empty entries", () => {
    expect(parseModelChain("a,, b, ,c")).toEqual(["a", "b", "c"]);
  });

  it("returns [] for empty or blank input", () => {
    expect(parseModelChain("")).toEqual([]);
    expect(parseModelChain("   ")).toEqual([]);
    expect(parseModelChain(",,,")).toEqual([]);
  });

  it("keeps fuzzy names as-is (resolution is the caller's job)", () => {
    expect(parseModelChain("haiku, sonnet")).toEqual(["haiku", "sonnet"]);
  });
});

describe("isUsageLimitError", () => {
  describe("positive — usage limits", () => {
    it("matches the observed hourly free-allowance message", () => {
      expect(isUsageLimitError(new Error("You've hit the hourly free allowance for gpt-5.6-luna"))).toBe(true);
    });

    it("matches the free-allowance message as a plain string", () => {
      expect(isUsageLimitError("You've hit the hourly free allowance for gpt-5.6-luna")).toBe(true);
    });

    it("matches a standalone 429 status", () => {
      expect(isUsageLimitError("Request failed with status 429")).toBe(true);
      expect(isUsageLimitError("HTTP 429 Too Many Requests")).toBe(true);
      expect(isUsageLimitError(new Error("error 429"))).toBe(true);
    });

    it("matches rate-limit spellings case-insensitively", () => {
      expect(isUsageLimitError("Rate limit exceeded, retry later")).toBe(true);
      expect(isUsageLimitError("RATE_LIMIT_EXCEEDED")).toBe(true);
      expect(isUsageLimitError("ratelimit hit")).toBe(true);
    });

    it("matches quota errors", () => {
      expect(isUsageLimitError("insufficient_quota: you exceeded your current quota")).toBe(true);
      expect(isUsageLimitError("Quota exceeded for project")).toBe(true);
    });

    it("matches usage-limit spellings", () => {
      expect(isUsageLimitError("usage limit reached")).toBe(true);
      expect(isUsageLimitError("USAGE_LIMIT")).toBe(true);
    });

    it("matches a numeric 429 status field without message text", () => {
      expect(isUsageLimitError({ status: 429 })).toBe(true);
      expect(isUsageLimitError({ statusCode: "429" })).toBe(true);
    });
  });

  describe("negative — ambiguous errors never fall back", () => {
    it("rejects stream-disconnect wording (retry path owns those)", () => {
      expect(isUsageLimitError("stream disconnected before completion")).toBe(false);
      expect(isUsageLimitError("Anthropic stream ended before message_stop")).toBe(false);
      expect(isUsageLimitError("socket hang up")).toBe(false);
      expect(isUsageLimitError("upstream execution failed")).toBe(false);
    });

    it("rejects a generic 500", () => {
      expect(isUsageLimitError("Internal Server Error (500)")).toBe(false);
      expect(isUsageLimitError(new Error("request failed with status 500"))).toBe(false);
    });

    it("rejects empty input", () => {
      expect(isUsageLimitError("")).toBe(false);
      expect(isUsageLimitError(new Error(""))).toBe(false);
      expect(isUsageLimitError(null)).toBe(false);
      expect(isUsageLimitError(undefined)).toBe(false);
    });

    it("rejects congestion wording (overloaded recovers by waiting, not switching)", () => {
      expect(isUsageLimitError("retries exhausted: 529 overloaded")).toBe(false);
      expect(isUsageLimitError("the model is overloaded")).toBe(false);
    });

    it("rejects nearby numbers that are not 429", () => {
      expect(isUsageLimitError("error 14290")).toBe(false);
      expect(isUsageLimitError("status 4290")).toBe(false);
      expect(isUsageLimitError("529 overloaded")).toBe(false);
    });

    it("rejects unrelated failures", () => {
      expect(isUsageLimitError("authentication failed")).toBe(false);
      expect(isUsageLimitError({ status: 500 })).toBe(false);
      expect(isUsageLimitError({ message: "nope" })).toBe(false);
    });
  });
});

describe("isUsageLimitError — auth 系（実測文言）", () => {
  it("matches 503 auth_unavailable", () => {
    expect(isUsageLimitError(
      '503: {"message":"auth_unavailable: no auth available (providers=openai-compatible-cline, model=cline-muse-spark-1.3; ...)"}',
    )).toBe(true);
  });

  it("matches no-auth-available spellings case-insensitively", () => {
    expect(isUsageLimitError("AUTH_UNAVAILABLE")).toBe(true);
    expect(isUsageLimitError("No Auth Available for model")).toBe(true);
    expect(isUsageLimitError(new Error("auth_unavailable: no auth available"))).toBe(true);
  });

  it("still rejects plain auth wording without the unavailable marker", () => {
    expect(isUsageLimitError("authentication failed")).toBe(false);
    expect(isUsageLimitError("unauthorized")).toBe(false);
  });
});

describe("parseRetryDelaySeconds", () => {
  it("parses the observed Server-requested form (21555s, not the trailing max)", () => {
    expect(parseRetryDelaySeconds("Server requested 21555s retry delay (max: 12s). 503 auth_unavailable: ...")).toBe(21555);
  });

  it("parses a short Server-requested delay (300s)", () => {
    expect(parseRetryDelaySeconds("Server requested 300s retry delay (max: 12s). 503 auth_unavailable: ...")).toBe(300);
  });

  it("parses retry-after forms with unit conversion", () => {
    expect(parseRetryDelaySeconds("retry-after: 120")).toBe(120);
    expect(parseRetryDelaySeconds("Retry-After: 5 minutes, slow down")).toBe(300);
    expect(parseRetryDelaySeconds("retry after 2 hours")).toBe(7200);
  });

  it("accepts Error and { message } shapes", () => {
    expect(parseRetryDelaySeconds(new Error("Server requested 300s retry delay"))).toBe(300);
    expect(parseRetryDelaySeconds({ message: "Server requested 300s retry delay" })).toBe(300);
  });

  it("returns undefined when no retry delay is present", () => {
    expect(parseRetryDelaySeconds("Connection error.")).toBe(undefined);
    expect(parseRetryDelaySeconds("429: Daily free limit reached")).toBe(undefined);
    expect(parseRetryDelaySeconds("")).toBe(undefined);
    expect(parseRetryDelaySeconds(null)).toBe(undefined);
  });

  it("exposes the 30-minute (1800s) fallback boundary", () => {
    expect(RETRY_DELAY_FALLBACK_THRESHOLD_S).toBe(1800);
  });
});

describe("実データ5件の分類（仕様通り）", () => {
  const INFERENCE_CAP_429 =
    '429: {"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit reached on model meta/muse-spark-1.3-contributor. Try again in 18h 1m"}';
  const AUTH_503 =
    '503: {"message":"auth_unavailable: no auth available (providers=openai-compatible-cline, model=cline-muse-spark-1.3; ...)"}';
  const LONG_DELAY_AUTH =
    "Server requested 21555s retry delay (max: 12s). 503 auth_unavailable: no auth available (providers=openai-compatible-cline, model=cline-muse-spark-1.3; ...)";
  const SHORT_DELAY_AUTH =
    "Server requested 300s retry delay (max: 12s). 503 auth_unavailable: no auth available (providers=openai-compatible-cline, model=cline-muse-spark-1.3; ...)";
  const CONNECTION_ERROR = "Connection error.";

  // agent-runner 本番分岐と同一実体（テスト側の複製なし）。

  it("429 INFERENCE_CAP → フォールバック", () => {
    expect(isUsageLimitError(INFERENCE_CAP_429)).toBe(true);
    expect(classifyRetryFailure(INFERENCE_CAP_429)).toBe("fallback");
  });

  it("503 auth_unavailable → フォールバック（新規）", () => {
    expect(isUsageLimitError(AUTH_503)).toBe(true);
    expect(classifyRetryFailure(AUTH_503)).toBe("fallback");
  });

  it("21555s delay → 1800s 超なのでフォールバック（新規）", () => {
    expect(parseRetryDelaySeconds(LONG_DELAY_AUTH)).toBe(21555);
    expect(classifyRetryFailure(LONG_DELAY_AUTH)).toBe("fallback");
  });

  it("300s delay → 1800s 以内なので自前リトライ（新規）", () => {
    expect(parseRetryDelaySeconds(SHORT_DELAY_AUTH)).toBe(300);
    expect(classifyRetryFailure(SHORT_DELAY_AUTH)).toBe("own-retry");
  });

  it("Connection error. → 現状維持（対象外）", () => {
    expect(isUsageLimitError(CONNECTION_ERROR)).toBe(false);
    expect(parseRetryDelaySeconds(CONNECTION_ERROR)).toBe(undefined);
    expect(classifyRetryFailure(CONNECTION_ERROR)).toBe("as-is");
  });

  it("境界 1800s → 自前リトライ、1801s → フォールバック", () => {
    expect(classifyRetryFailure("Server requested 1800s retry delay (max: 12s). 503 auth_unavailable: ...")).toBe("own-retry");
    expect(classifyRetryFailure("Server requested 1801s retry delay (max: 12s). 503 auth_unavailable: ...")).toBe("fallback");
  });
});
