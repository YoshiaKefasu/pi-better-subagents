import { Type } from "@sinclair/typebox";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentInvocation, IsolationMode, JoinMode, ThinkingLevel } from "./types.js";
import { parseModelChain } from "./model-fallback-chain.js";
import { describeModel, type ModelRegistry, resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";

/**
 * The model-facing `isolation` parameter, shared by the `Agent` tool and the
 * nested delegation tool so the two cannot drift.
 *
 * Shape matters more than wording here. As a single-value optional literal,
 * models that fill every optional parameter — the transcript on #231 shows one
 * emitting `resume: ""`, `schedule: ""` and `model: "default"` alongside it —
 * had only `"worktree"` available to fill it with, and kept spawning worktrees
 * across three turns while their own reasoning said to omit the field. Every
 * other optional parameter has an inert filler; this one did not. `"off"` is
 * listed first and described as the default so the harmless value is the
 * obvious one to reach for.
 *
 * The wording tracks Claude Code's own `isolation` parameter, whose phrasing
 * models have the most exposure to: one description on the union rather than
 * per-value ones, opening "Isolation mode.", then a sentence per value in
 * schema order, each with its caveats in a trailing parenthetical. Two clauses
 * are ours, because our shape is not theirs — `"off"` has no counterpart there
 * (their enum is `worktree | remote`, so both of their values do something),
 * and neither does the uncommitted-work warning, which is the specific trap
 * #231 fell into. Deliberately absent is any "only use a worktree when…"
 * restriction: Claude Code's `Agent` tool states the capability and stops, and
 * a second legal value is what lets a model decline one, not being told to.
 */
const isolationParamShape = {
  isolation: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("worktree")], {
      description:
        'Isolation mode. Default "off". "off" runs the agent in the current checkout, the same as omitting the field. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo (a copy cannot see uncommitted or staged changes in the main checkout).',
    }),
  ),
};

/**
 * Build the `isolation` parameter for a tool schema, or nothing when the
 * project disabled worktrees (`worktreeIsolation: false`).
 *
 * Dropping the field beats accepting it and quietly downgrading. The setting is
 * for a project whose model passes `"worktree"` on *every* call, so a
 * per-result "isolation was disabled" note would be noise on every result and
 * would keep raising the salience of a capability that isn't there. With no
 * field there is nothing to pass, nothing to drop, and nothing to explain — the
 * same trade `scheduleParam` makes for disabled scheduling, at zero LLM-context
 * cost. The resolver gate and the `agent-manager` check still cover the paths a
 * schema can't reach: agent files, the scheduler, and cross-extension RPC.
 *
 * Like `scheduleParam`, this is read once at tool registration — flipping the
 * setting needs a new pi session for the schema to change.
 */
export function isolationParam(enabled: boolean): Partial<typeof isolationParamShape> {
  return enabled ? isolationParamShape : {};
}

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  /**
   * Untyped on purpose. Both tool schemas now build this field conditionally
   * and spread it, which erases TypeBox's literal inference to `unknown` (the
   * `schedule` param has the same shape). The resolver below narrows by
   * comparison rather than trusting the declaration, which also makes it safe
   * for the cross-extension RPC path, where options arrive unvalidated.
   */
  isolation?: unknown;
}

interface ResolveOptions {
  /**
   * Whether worktree isolation is permitted at all. False when the project set
   * `worktreeIsolation: false`, which drops a requested worktree rather than
   * failing the call: the fail-loud precedent covers spawns that *cannot* work,
   * while this one is the user opting out, and throwing would break exactly the
   * calls the `"off"` value exists to tolerate. Defaults to allowed.
   */
  worktreeAllowed?: boolean;
  /**
   * What an unqualified spawn means — neither the call nor the agent file said.
   *
   * Top-level callers pass the `backgroundByDefault` setting (default `true`,
   * following Claude Code). Nested callers pass `false` unconditionally: a
   * detached child is killed by `abortOwnedChildren` when its parent settles
   * and has no notification path of its own, so backgrounding one loses its
   * work. Both call sites pass it explicitly; the `false` fallback only covers
   * a caller that supplies no options at all, which in-tree means tests.
   */
  defaultRunInBackground?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
  opts?: ResolveOptions,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
  /**
   * Caller parameters an agent file's frontmatter outranked, so the surfaces can
   * say "(asked X)" instead of presenting the effective value as the requested
   * one (#182). Populated only where both sides named something and they
   * disagree — a caller who asked for what they got was still honored.
   *
   * `max_turns` is deliberately absent: no surface renders a requested-vs-
   * effective turn limit, so recording one would be dead data.
   */
  overridden?: { thinking?: ThinkingLevel; model?: string };
} {
  // Precedence first, collapse second — reversing these loses the veto, since
  // an agent file's "off" only outranks a caller's "worktree" while it is still
  // a value. Everything downstream then sees "worktree" or nothing at all.
  const requested = agentConfig?.isolation ?? params.isolation;
  const isolation = requested === "worktree" && opts?.worktreeAllowed !== false ? "worktree" : undefined;

  // Caller parameters (params.model / params.thinking) outrank the agent file's
  // frontmatter, allowing temporary model/thinking overrides at spawn time.
  const modelInput = params.model ?? agentConfig?.model;
  const modelFromParams = params.model != null;
  const thinking = (params.thinking ?? agentConfig?.thinking) as ThinkingLevel | undefined;

  return {
    modelInput,
    modelFromParams,
    thinking,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? opts?.defaultRunInBackground ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation,
    overridden: undefined,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}

/**
 * resume 時に live session のモデルを有効値へ合わせる。優先順位は新規 spawn
 * （agent-runner の resolveDefaultModel）と同じ: 明示指定 > frontmatter > 親モデル。
 * thinking が無条件に再適用されるのと対称にするためのもので、これが無いと
 * 前回実行時のモデルが残り続ける。
 *
 * 安全条件:
 * - 解決結果が undefined なら setModel しない
 * - 既に同じモデル（provider + id）ならスキップ
 *   （無駄な model_change 追記とプロンプトキャッシュ破壊を避ける）
 * - frontmatter 由来の失敗は握って続行（resume を失敗させない）。
 *   明示指定の失敗だけエラー文字列で返し、呼び出し元が textResult 化する。
 */
export async function applyResumeModel(args: {
  modelRegistry: ModelRegistry;
  parentModel?: Model<any>;
  cwd: string;
  notifyWarning?: (msg: string) => void;
  /** 呼び出し元の明示指定 (params.model)。無ければ frontmatterModel を使う。 */
  modelInput?: string;
  /** resume 対象レコードの型の frontmatter `model:`。 */
  frontmatterModel?: string;
  session?: AgentSession;
  invocation?: AgentInvocation;
  agentLabel: string;
}): Promise<string | undefined> {
  const fromParams = args.modelInput != null;
  const input = args.modelInput ?? args.frontmatterModel;
  let target: Model<any> | undefined;
  if (input) {
    // resume は既存セッションへの切替のため連鎖は使わず先頭のみ。
    const resolved: Model<any> | string = resolveModel(
      parseModelChain(input)[0] ?? input,
      args.modelRegistry,
    );
    if (typeof resolved === "string") {
      // 明示指定の解決失敗は従来通り呼び出し元へ返す。
      // frontmatter 由来は spawn 経路と同様に親モデルのまま続行。
      if (fromParams) return resolved;
      target = args.parentModel;
    } else {
      target = resolved;
    }
  } else {
    target = args.parentModel;
  }
  if (!target) return undefined;
  const scopeVerdict = checkModelScope({
    model: target,
    cwd: args.cwd,
    modelRegistry: args.modelRegistry,
    callerSupplied: fromParams,
    agentLabel: args.agentLabel,
    modelInput: input,
  });
  if (scopeVerdict.kind === "error") {
    // kind:"error" は callerSupplied(= fromParams) が true のときだけ返る
    // （model-scope.ts）。!fromParams では到達不能のため分岐を持たない。
    if (fromParams) return scopeVerdict.message;
  }
  if (scopeVerdict.kind === "warn") args.notifyWarning?.(scopeVerdict.message);
  const session = args.session;
  if (!session) return undefined;
  try {
    if (session.model?.provider === target.provider && session.model?.id === target.id) {
      return undefined;
    }
    await session.setModel(target);
    if (args.invocation) {
      const { modelName, modelId } = describeModel(target);
      args.invocation.modelName = modelName;
      args.invocation.modelId = modelId;
    }
  } catch (err) {
    if (fromParams) {
      return `Failed to switch model on resume: ${err instanceof Error ? err.message : String(err)}`;
    }
    /* frontmatter への復帰失敗は握って続行 */
  }
  return undefined;
}
