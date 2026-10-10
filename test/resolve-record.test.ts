// resolveRecord: exact id, handle/alias, or unique id prefix.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

describe("AgentManager — resolveRecord", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new AgentManager();
  });

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  async function spawnOne(prompt: string): Promise<string> {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    } as any);
    const id = manager.spawn(mockPi, mockCtx, "X", prompt, { description: prompt, isBackground: true });
    await manager.getRecord(id)!.promise;
    return id;
  }

  it("resolves an exact id", async () => {
    const id = await spawnOne("a");
    expect(manager.resolveRecord(id)?.id).toBe(id);
  });

  it("resolves a unique id prefix", async () => {
    const id = await spawnOne("a");
    expect(manager.resolveRecord(id.slice(0, 8))?.id).toBe(id);
  });

  it("returns undefined for an ambiguous prefix", async () => {
    await spawnOne("a");
    await spawnOne("b");
    // Empty string is a prefix of every id -> always ambiguous with 2+ agents.
    expect(manager.resolveRecord("")).toBeUndefined();
  });

  it("returns undefined for unknown ids", async () => {
    await spawnOne("a");
    expect(manager.resolveRecord("nope-nope-nope")).toBeUndefined();
  });

  it("resolves handle and alias case-insensitively", async () => {
    const id = await spawnOne("a");
    const record = manager.getRecord(id)!;
    if (record.handle) {
      expect(manager.resolveRecord(record.handle.toUpperCase())?.id).toBe(id);
    }
    if (record.alias) {
      expect(manager.resolveRecord(record.alias)?.id).toBe(id);
    }
  });
});
