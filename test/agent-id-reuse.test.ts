// reclaim.id による ID 再利用の unit テスト。
//
// 背景: tombstone/disk からの resume は会話ファイルを開き直した新規レコード
// として実装され、spawn 時の randomUUID() 採番で ID が毎回変わっていた。
// tombstone は古い ID を保持しているため、reclaim.id として渡して再利用し、
// resume 後も同一 ID を保つ。ID が現存レコードと衝突する場合は新規採番する
// （ID 重複は絶対に起こさない）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

describe("AgentManager — reclaim.id による ID 再利用", () => {
  let manager: AgentManager | undefined;

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
  });

  function resolvedRun() {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
  }

  /** spawn して settle まで待つ。worktree 無効化済みのため startup は即時。 */
  async function settled(prompt: string, extra: Record<string, unknown> = {}) {
    resolvedRun();
    manager ??= new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", prompt, {
      description: prompt,
      isBackground: true,
      ...extra,
    } as any);
    await manager.awaitStartup(id);
    await manager.getRecord(id)!.promise;
    return manager.getRecord(id)!;
  }

  it("disk reopen: reclaim.id で同一 ID が復活する", async () => {
    const first = await settled("first", { name: "auth-audit" });
    const oldId = first.id;
    const oldStartedAt = first.startedAt;
    expect(first.status).toBe("completed");

    // GC / セッション境界相当: clearCompleted でレコードを落とす。会話は Disk に
    // 残るので、reopen 側が handle/alias/id を reclaim して同一性を保つ。
    manager!.clearCompleted();
    expect(manager!.getRecord(oldId)).toBeUndefined();
    // reopen 元として覚えているのは Disk のセッションファイルだけ。
    const sessionFile = first.sessionFile ?? "/tmp/never-used.jsonl";

    // resume 経路相当: 落としたレコードの handle/alias/id を reclaim して spawn。
    resolvedRun();
    const resumedId = manager!.spawn(mockPi, mockCtx, "general-purpose", "follow-up", {
      description: "follow-up",
      isBackground: true,
      reclaim: { handle: first.handle, alias: first.alias, id: oldId },
      resumeSessionFile: sessionFile,
    } as any);
    await manager!.awaitStartup(resumedId);
    await manager!.getRecord(resumedId)!.promise;

    // ID・handle ともに同一。
    expect(resumedId).toBe(oldId);
    const resumed = manager!.getRecord(resumedId)!;
    expect(resumed.handle).toBe(first.handle);
    expect(resumed.alias).toBe(first.alias);
    // 中身は新しい実行として扱う: 実行メタは新規で、前回の結果は持ち越さない。
    expect(resumed.startedAt).toBeGreaterThanOrEqual(oldStartedAt);
    expect(resumed.completedAt).toBeDefined(); // 今回の実行で settle 済み
    expect(resumed.result).toBe("done"); // 今回の実行結果（前回の残骸ではない）
    expect(resumed.error).toBeUndefined();
  });

  it("衝突時: reclaim.id が生きている場合は新規採番する", async () => {
    manager ??= new AgentManager();
    resolvedRun();
    // 未完了の live レコードを作る（runAgent を保留して running のままにする）。
    let release!: (v: unknown) => void;
    vi.mocked(runAgent).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }) as any,
    );
    const liveId = manager.spawn(mockPi, mockCtx, "general-purpose", "live", {
      description: "live",
      isBackground: true,
    });
    await manager.awaitStartup(liveId);
    expect(manager.getRecord(liveId)!.status).toBe("running");

    // 生きている ID を reclaim.id に指定 → 衝突回避で新規採番される。
    resolvedRun();
    const otherId = manager.spawn(mockPi, mockCtx, "general-purpose", "other", {
      description: "other",
      isBackground: true,
      reclaim: { handle: "ghost-handle", id: liveId },
    } as any);
    expect(otherId).not.toBe(liveId);
    expect(typeof otherId).toBe("string");
    expect(otherId.length).toBeGreaterThan(0);
    // live 側は無傷、reclaim 側の handle 引き継ぎは従来通り。
    expect(manager.getRecord(liveId)).toBeDefined();
    expect(manager.getRecord(otherId)!.handle).toBe("ghost-handle");

    // 後片付け: 保留中の run を終わらせる。
    release({ responseText: "live done", session: { dispose: vi.fn() }, aborted: false, steered: false });
    await manager.getRecord(liveId)!.promise;
    await manager.getRecord(otherId)!.promise;
  });

  it("reclaim 無しの通常 spawn は毎回新規 ID になる", async () => {
    const a = await settled("a");
    const b = await settled("b");
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  it("空文字の reclaim.id は無視して新規採番する", async () => {
    manager ??= new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "x", {
      description: "x",
      isBackground: true,
      reclaim: { handle: "some-handle", id: "" },
    } as any);
    await manager.awaitStartup(id);
    await manager.getRecord(id)!.promise;
    expect(id).toBeTruthy();
    expect(id).not.toBe("");
    expect(manager.getRecord(id)!.handle).toBe("some-handle");
  });
});
