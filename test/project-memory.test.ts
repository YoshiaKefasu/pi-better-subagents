import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { buildProjectMemoryBlock, resolveCurrentProjectIdentity } from "../src/project-memory.js";
import { buildAgentPrompt } from "../src/prompts.js";
import type { AgentConfig, EnvInfo } from "../src/types.js";

/**
 * Only the columns `src/project-memory.ts` actually reads are declared — the real
 * `memories` table carries embedding, mural, and verification columns this
 * module never touches. `project_path` stores the resolved identity
 * (`git:<root>` / `dir:<md5-12>`), which is the join key.
 */
const MEMORIES_SCHEMA = `CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  normalized_hash TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  importance INTEGER,
  last_seen_at INTEGER,
  verified_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const env: EnvInfo = { isGitRepo: true, branch: "main", platform: "win32" };

interface MemoryInput {
  category: string;
  content: string;
  status?: string;
  importance?: number | null;
  lastSeenAt?: number | null;
  verifiedAt?: number | null;
  expiresAt?: number | null;
}

interface TestDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}

/** `node:sqlite` through a require, so the fixtures can write their own store. */
function sqlite(): { DatabaseSync: new (path: string) => TestDatabase } {
  return createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => TestDatabase;
  };
}

let scratchDir: string;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "pi-project-memory-"));
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

/** A fresh project directory + database pair. Each test gets its own identity. */
function makeStore(name: string): { cwd: string; dbPath: string; identity: string } {
  const cwd = join(scratchDir, name);
  mkdirSync(cwd, { recursive: true });
  const dbPath = join(cwd, "context.db");
  return {
    cwd,
    dbPath,
    identity: `dir:${createHash("md5").update(resolve(cwd), "utf8").digest("hex").slice(0, 12)}`,
  };
}

function writeMemories(dbPath: string, projectPath: string, rows: MemoryInput[]): void {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(MEMORIES_SCHEMA);
    const insert = db.prepare(
      `INSERT INTO memories (project_path, category, content, normalized_hash, status,
                             importance, last_seen_at, verified_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [index, row] of rows.entries()) {
      const now = 1_700_000_000_000 + index;
      insert.run(
        projectPath,
        row.category,
        row.content,
        `hash-${index}`,
        row.status ?? "active",
        row.importance ?? null,
        row.lastSeenAt ?? null,
        row.verifiedAt ?? null,
        row.expiresAt ?? null,
        now,
        now,
      );
    }
  } finally {
    db.close();
  }
}

function replaceConfig(name: string): AgentConfig {
  return {
    name,
    description: "Test",
    builtinToolNames: [],
    extensions: true,
    skills: true,
    systemPrompt: "You are a specialized agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  };
}

function appendConfig(name: string): AgentConfig {
  return { ...replaceConfig(name), promptMode: "append", systemPrompt: "Custom instructions." };
}

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("resolveCurrentProjectIdentity", () => {
  it("falls back to the directory hash for a non-git directory", () => {
    const { cwd } = makeStore("identity-dir");
    const expected = createHash("md5").update(resolve(cwd), "utf8").digest("hex").slice(0, 12);
    expect(resolveCurrentProjectIdentity(cwd)).toBe(`dir:${expected}`);
  });

  it.skipIf(!gitAvailable)("uses the root commit hash for a git repository", () => {
    const { cwd } = makeStore("identity-git");
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--allow-empty", "-m", "init"], {
      cwd,
      stdio: "ignore",
    });
    const root = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd,
      encoding: "utf8",
    })
      .trim()
      .split("\n")[0]
      .trim();
    expect(resolveCurrentProjectIdentity(cwd)).toBe(`git:${root}`);
  });
});

describe("buildProjectMemoryBlock", () => {
  it("renders a category-grouped <project-memory> block in category priority order", () => {
    const { cwd, dbPath, identity } = makeStore("render");
    writeMemories(dbPath, identity, [
      { category: "CONFIG_VALUES", content: "config value line" },
      { category: "PROJECT_RULES", content: "rule line" },
      { category: "NAMING", content: "naming line" },
      { category: "ARCHITECTURE", content: "architecture line" },
    ]);

    const block = buildProjectMemoryBlock(cwd, dbPath);
    expect(block).toBeDefined();
    expect(block!.startsWith("<project-memory>")).toBe(true);
    expect(block!.endsWith("</project-memory>")).toBe(true);
    // Wire form: `#<id>: <content>`, one line per memory.
    expect(block).toMatch(/#\d+: rule line/);
    // Categories render in CATEGORY_PRIORITY order, not insertion order.
    const order = ["PROJECT_RULES", "ARCHITECTURE", "CONFIG_VALUES", "NAMING"].map((category) =>
      block!.indexOf(`<${category}>`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("skips archived and expired memories", () => {
    const { cwd, dbPath, identity } = makeStore("status");
    writeMemories(dbPath, identity, [
      { category: "PROJECT_RULES", content: "live rule" },
      { category: "PROJECT_RULES", content: "archived rule", status: "archived" },
      { category: "PROJECT_RULES", content: "superseded rule", status: "superseded" },
      { category: "PROJECT_RULES", content: "expired rule", expiresAt: Date.now() - 1 },
    ]);

    const block = buildProjectMemoryBlock(cwd, dbPath);
    expect(block).toContain("live rule");
    expect(block).not.toContain("archived rule");
    expect(block).not.toContain("superseded rule");
    expect(block).not.toContain("expired rule");
  });

  it("includes permanent memories", () => {
    const { cwd, dbPath, identity } = makeStore("permanent");
    writeMemories(dbPath, identity, [
      { category: "PROJECT_RULES", content: "pinned rule", status: "permanent" },
    ]);

    expect(buildProjectMemoryBlock(cwd, dbPath)).toContain("pinned rule");
  });

  it("escapes XML-significant characters in content", () => {
    const { cwd, dbPath, identity } = makeStore("escape");
    writeMemories(dbPath, identity, [
      { category: "PROJECT_RULES", content: "use a < b & c > d" },
    ]);

    const block = buildProjectMemoryBlock(cwd, dbPath);
    expect(block).toContain("use a &lt; b &amp; c &gt; d");
    expect(block).not.toContain("use a < b");
  });

  it("returns undefined when the database file does not exist", () => {
    const { cwd } = makeStore("missing-db");
    expect(buildProjectMemoryBlock(cwd, join(cwd, "no-such.db"))).toBeUndefined();
  });

  it("returns undefined when the project has no memories", () => {
    const { cwd, dbPath, identity } = makeStore("empty");
    writeMemories(dbPath, identity, []);
    expect(buildProjectMemoryBlock(cwd, dbPath)).toBeUndefined();
  });

  it("returns undefined when the memories belong to another project", () => {
    const { cwd, dbPath } = makeStore("other-project");
    writeMemories(dbPath, "dir:000000000000", [
      { category: "PROJECT_RULES", content: "someone else's rule" },
    ]);
    expect(buildProjectMemoryBlock(cwd, dbPath)).toBeUndefined();
  });

  it("fails open on a database that is not SQLite", () => {
    const { cwd, dbPath } = makeStore("garbage");
    writeFileSync(dbPath, "this is not a sqlite database", "utf-8");
    expect(buildProjectMemoryBlock(cwd, dbPath)).toBeUndefined();
  });

  it("picks up a memory pinned after the first call", () => {
    const { cwd, dbPath, identity } = makeStore("freshness");
    writeMemories(dbPath, identity, [{ category: "PROJECT_RULES", content: "first rule" }]);
    expect(buildProjectMemoryBlock(cwd, dbPath)).toContain("first rule");

    // A sibling subagent pins a memory between two spawns.
    writeMemories(dbPath, identity, [
      { category: "ARCHITECTURE", content: "second rule" },
    ]);

    expect(buildProjectMemoryBlock(cwd, dbPath)).toContain("second rule");
  });

  it("trims to the token budget, keeping permanent and high-importance rows", () => {
    const { cwd, dbPath, identity } = makeStore("budget");
    const rows: MemoryInput[] = [
      { category: "PROJECT_RULES", content: "PINNEDMARKER short rule", status: "permanent", importance: 90 },
      { category: "ARCHITECTURE", content: `BIGMARKER${"x".repeat(100_000)}` },
    ];
    for (let index = 0; index < 100; index += 1) {
      rows.push({ category: "CONFIG_VALUES", content: `filler-${index}`, importance: 50 });
    }
    writeMemories(dbPath, identity, rows);

    const block = buildProjectMemoryBlock(cwd, dbPath)!;
    expect(block).toContain("PINNEDMARKER");
    expect(block).not.toContain("BIGMARKER");
    // Mirrors Magic Context's DEFAULT_MEMORY_BUDGET_TOKENS with a chars/4 estimate.
    expect(Math.ceil(block.length / 4)).toBeLessThanOrEqual(8_000);
  });
});

describe("project memory in agent prompts", () => {
  beforeAll(() => {
    registerAgents(new Map());
  });

  it("reaches a replace-mode custom agent that never sees the parent prompt", () => {
    const { cwd, dbPath, identity } = makeStore("prompt-replace");
    writeMemories(dbPath, identity, [{ category: "PROJECT_RULES", content: "replace-mode rule" }]);
    const block = buildProjectMemoryBlock(cwd, dbPath)!;

    const prompt = buildAgentPrompt(replaceConfig("custom"), cwd, env, "SECRET parent prompt", {
      projectMemoryBlock: block,
    });

    expect(prompt).toContain("<project-memory>");
    expect(prompt).toContain("replace-mode rule");
    // Still a replace-mode prompt: no parent identity, no sub_agent_context bridge.
    expect(prompt).not.toContain("SECRET parent prompt");
    expect(prompt).not.toContain("<sub_agent_context>");
    // Appended after the agent's own instructions.
    expect(prompt.indexOf("<project-memory>")).toBeGreaterThan(prompt.indexOf("You are a specialized agent."));
    expect(prompt.indexOf("<project-memory>")).toBeGreaterThan(prompt.indexOf('<active_agent name="custom"/>'));
  });

  it("reaches an append-mode agent too", () => {
    const { cwd, dbPath, identity } = makeStore("prompt-append");
    writeMemories(dbPath, identity, [{ category: "ARCHITECTURE", content: "append-mode rule" }]);
    const block = buildProjectMemoryBlock(cwd, dbPath)!;

    const prompt = buildAgentPrompt(appendConfig("appender"), cwd, env, "Parent prompt.", {
      projectMemoryBlock: block,
    });

    expect(prompt).toContain("<project-memory>");
    expect(prompt).toContain("append-mode rule");
    // Stays out of the cacheable inherited prefix so the KV cache still hits.
    expect(prompt.startsWith("Parent prompt.")).toBe(true);
    expect(prompt.indexOf("<project-memory>")).toBeGreaterThan(prompt.indexOf("<sub_agent_context>"));
  });

  it("injects whatever the real builder produced, for a default agent", () => {
    const { cwd, dbPath, identity } = makeStore("prompt-default");
    writeMemories(dbPath, identity, [{ category: "NAMING", content: "default-agent rule" }]);

    const prompt = buildAgentPrompt(getAgentConfig("general-purpose")!, cwd, env, "Parent prompt.", {
      projectMemoryBlock: buildProjectMemoryBlock(cwd, dbPath),
    });

    expect(prompt).toContain("default-agent rule");
  });

  it("adds nothing when there is no project memory", () => {
    const { cwd, dbPath } = makeStore("prompt-none");
    const prompt = buildAgentPrompt(replaceConfig("custom"), cwd, env, undefined, {
      projectMemoryBlock: buildProjectMemoryBlock(cwd, dbPath),
    });
    expect(prompt).not.toContain("<project-memory>");
  });
});
