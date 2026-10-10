/**
 * stop-suppresses-notification.test.ts — stop ツール経由の停止では遅延の完了通知を出さない。
 *
 * 現象: stop_subagent が同期的に「Stopped agent …」を返した後、settle 時に
 * 遅延の完了通知（`<status>Stopped</status> … tool_uses … No output.`）が
 * 別途届く重複ノイズ。停止結果はツール応答で確定済みなので後の通知は不要。
 *
 * 仕様の区別:
 * - stop ツール経由の停止 → resultConsumed を立て、settle 時の通知のみ抑止
 *   （lifecycle イベント・履歴追記・widget/fleet 更新は従来通り）。
 * - TUI 詳細ビューの「x stop」ボタン経由の停止（manager.abort の直接呼び出し、
 *   resultConsumed なし）→ 従来通り通知する。ユーザーが結果を知る必要があるため。
 * - 自然終了（completed/error）→ 従来通り通知する。
 *
 * REAL 拡張（src/index.ts）を通す wiring テスト。runAgent のみモックし、
 * manager・settle・通知ルーティングは本物を使う。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};
// NUDGE_HOLD_MS（200ms）より十分長い固定待機。通知の「不在」は
// ポーリングで証明できないため、ホールド時間を上回る単発スリープで見る。
const LONGER_THAN_NUDGE_HOLD_MS = 600;

function notificationsFor(pi: any, id: string) {
  return vi
    .mocked(pi.sendMessage)
    .mock.calls.filter(
      (c: any[]) => c[0]?.customType === "subagent-notification" && JSON.stringify(c[0]).includes(id),
    );
}

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "stop-notify test agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(r))?.[1];
  expect(id, "background spawn should surface an agent id").toBeTruthy();
  return id as string;
}

/** runAgent を手動解決式にし、resolver を返す（停止→settle の順序を再現するため）。 */
function deferredRun() {
  let resolveRun: (v: any) => void = () => {};
  vi.mocked(runAgent).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRun = resolve;
      }) as any,
  );
  return (v: any) => resolveRun(v);
}

const settledPayload = {
  responseText: "partial work",
  session: { dispose: vi.fn() },
  aborted: false,
  steered: false,
};

describe("stop_subagent suppresses the delayed completion notification", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.restoreAllMocks();
  });

  it("stop ツールで止めた agent は settle しても遅延通知が出ない（イベント・履歴は残る）", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const resolveRun = deferredRun();

    const id = await spawnBackground(tools);

    // 100ms の batch debounce を確実に過ぎてから止める（単発 spawn は
    // グループ化されないため、settle 後は individual nudge 経路になる）。
    await new Promise((r) => setTimeout(r, 150));

    const stopRes = await tools
      .get("stop_subagent")
      .execute("tc-stop", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(stopRes)).toContain("Stopped agent");

    // 停止後に run が settle（実機では abort した子セッションの終了が遅れて届く）。
    resolveRun({ ...settledPayload });
    await flush();
    await new Promise((r) => setTimeout(r, LONGER_THAN_NUDGE_HOLD_MS));
    await flush();

    // 遅延の完了通知は出ない。
    expect(notificationsFor(pi, id)).toHaveLength(0);

    // 抑止したのは通知だけ：lifecycle イベントと履歴追記は従来通り。
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:failed", expect.objectContaining({ id }));
    expect(pi.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({ id }));

    await lifecycle.get("session_shutdown")?.();
  });

  it("自然終了（completed）は従来通り通知される", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done work",
      session: { dispose: vi.fn() },
      aborted: false,
      steered: false,
    } as any);

    const id = await spawnBackground(tools);

    // 自然終了の通知が届くまでポーリング（NUDGE_HOLD 200ms + settle 連鎖の余裕）。
    let found = 0;
    for (let i = 0; i < 30 && found === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await flush();
      found = notificationsFor(pi, id).length;
    }
    expect(found, "natural completion should still notify").toBeGreaterThan(0);

    await lifecycle.get("session_shutdown")?.();
  });

  it("TUI 詳細ビューの x stop ボタン相当（manager.abort 直接）は従来通り通知される", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const resolveRun = deferredRun();

    const id = await spawnBackground(tools);
    await new Promise((r) => setTimeout(r, 150));

    // TUI の ConversationViewer onStop（src/index.ts の viewAgentConversation と
    // src/ui/fleet-list.ts）は stop ツールを経由せず manager.abort を直接呼ぶ。
    // レジストリの abort はその同一関数への passthrough なので、TUI 発起の停止を再現する。
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    expect(registry.abort(id)).toBe(true);

    resolveRun({ ...settledPayload });
    await flush();

    let found = 0;
    for (let i = 0; i < 30 && found === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await flush();
      found = notificationsFor(pi, id).length;
    }
    expect(found, "TUI-button stop should still notify").toBeGreaterThan(0);

    await lifecycle.get("session_shutdown")?.();
  });
});
