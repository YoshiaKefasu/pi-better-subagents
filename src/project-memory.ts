/**
 * project-memory.ts — Bridge Magic Context's project memory into subagent prompts.
 *
 * Why this exists: a `prompt_mode: "replace"` agent never receives the parent
 * system prompt, so the `<project-memory>` pinboard the parent session sees is
 * invisible to it — and anything a sibling subagent pins with `ctx_memory`
 * after that prompt was built is invisible to the next one. This module reads
 * the active memories for the current project straight out of Magic Context's
 * `context.db` at spawn time, so every subagent — custom or default — starts
 * from the same pinboard the parent sees.
 *
 * Everything here is best-effort: a missing database, a missing `node:sqlite`,
 * a broken git probe, or a locked store must degrade to `undefined`, never
 * throw. A subagent that loses its project memory is still a working agent.
 *
 * Identity and rendering mirror Magic Context's own implementations so the
 * bytes we emit are the bytes the parent session shows:
 *   - identity — `magic-context/packages/plugin/src/features/magic-context/memory/project-identity.ts`
 *     (`resolveProjectIdentityStrict` + `directoryFallback`)
 *   - selection and rendering — `.../hooks/magic-context/inject-compartments.ts`
 *     (`trimMemoriesToBudgetV2`, `renderMemoryBlockV2`, `memoryRenderOrder`),
 *     under `DEFAULT_MEMORY_BUDGET_TOKENS` = 8_000
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Budget for the injected block — Magic Context's `DEFAULT_MEMORY_BUDGET_TOKENS`. */
const MEMORY_BUDGET_TOKENS = 8_000;

/**
 * Chars-per-token divisor for the budget estimate. Magic Context measures with
 * the real tokenizer; this package has no tokenizer dependency, so a plain
 * char/4 estimate stands in. It is a conservative lower bound on real token
 * counts for prose, which keeps the rendered block at or under budget.
 */
const CHARS_PER_TOKEN = 4;

/** Git probe timeout — mirrors Magic Context's `GIT_TIMEOUT_MS`. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * Category render order: the v2 taxonomy first, then the legacy categories so
 * pre-v2 rows still render. Mirrors `V2_MEMORY_CATEGORIES` + `CATEGORY_PRIORITY`
 * in `magic-context/packages/plugin/src/features/magic-context/memory/constants.ts`.
 */
const CATEGORY_PRIORITY: readonly string[] = [
  "PROJECT_RULES",
  "ARCHITECTURE",
  "CONSTRAINTS",
  "CONFIG_VALUES",
  "NAMING",
  "USER_DIRECTIVES",
  "USER_PREFERENCES",
  "CONFIG_DEFAULTS",
  "ARCHITECTURE_DECISIONS",
  "ENVIRONMENT",
  "WORKFLOW_RULES",
  "KNOWN_ISSUES",
];

/** Statuses that render. `permanent` is the pinned twin of `active`. */
const LIVE_STATUSES = "('active', 'permanent')";

/** One memory row as read from `context.db`. */
interface ProjectMemoryRow {
  id: number;
  category: string;
  content: string;
  status: string;
  importance: number | null;
  lastSeenAt: number | null;
  verifiedAt: number | null;
}

/** The subset of the `node:sqlite` surface this module uses. */
interface SqliteDatabase {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
}

/**
 * Where Magic Context keeps its store. `~/.local/share/cortexkit/magic-context/context.db`
 * on every platform — the same path Magic Context itself resolves.
 */
export function resolveMagicContextDbPath(): string {
  return join(homedir(), ".local", "share", "cortexkit", "magic-context", "context.db");
}

/** Resolved identities are immutable per directory, so they are cached process-wide. */
const identityCache = new Map<string, string>();

/**
 * Resolve the project identity for `cwd` exactly the way Magic Context does.
 *
 *   - git repo with commits → `git:<root-commit-sha>`, the lexicographic minimum
 *     of the root set so a grafted history (`--allow-unrelated-histories`) cannot
 *     flap the identity between sessions
 *   - anything else → `dir:<md5(path.resolve(cwd))[0..12]>`
 *
 * Both forms are what `memories.project_path` stores, so matching them byte for
 * byte is what makes the lookup hit. Every failure — no git binary, timeout,
 * dubious ownership, unreadable directory — falls back to the `dir:` form.
 */
export function resolveCurrentProjectIdentity(cwd: string): string {
  const canonical = resolve(cwd);
  const cached = identityCache.get(canonical);
  if (cached !== undefined) return cached;

  let identity: string | undefined;
  try {
    const output = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: canonical,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    const rootCommit = String(output)
      .split("\n")
      .map((line) => line.trim().slice(0, 64))
      .filter((line) => /^[0-9a-f]{7,64}$/.test(line))
      .sort()[0];
    if (rootCommit) identity = `git:${rootCommit}`;
  } catch {
    // Not a repo, git missing, timed out, or refused the directory — fall through.
  }

  if (identity === undefined) {
    identity = `dir:${createHash("md5").update(canonical, "utf8").digest("hex").slice(0, 12)}`;
  }

  identityCache.set(canonical, identity);
  return identity;
}

interface CachedBlock {
  fingerprint: string;
  block: string | undefined;
}

/**
 * Rendered block per (database, identity), invalidated by the fingerprint query.
 * Keeps a burst of parallel spawns to one read of a 600 MB+ store instead of one
 * each, while still reflecting a memory pinned one call ago.
 */
const blockCache = new Map<string, CachedBlock>();

/**
 * Build the `<project-memory>` block for the project rooted at `cwd`, or
 * `undefined` when there is nothing to inject.
 *
 * `contextDbPath` overrides the default Magic Context store (tests, and anyone
 * running a store elsewhere). Callers inside this extension pass nothing.
 *
 * The result is cached per (database, identity) and invalidated by a fingerprint
 * query over the same rows, so a memory a sibling subagent just pinned is picked
 * up by the next spawn without re-reading and re-rendering on every call.
 */
export function buildProjectMemoryBlock(cwd: string, contextDbPath?: string): string | undefined {
  const dbPath = contextDbPath ?? resolveMagicContextDbPath();
  let identity: string;
  try {
    identity = resolveCurrentProjectIdentity(cwd);
  } catch {
    return undefined;
  }

  const cacheKey = `${dbPath}\u0000${identity}`;
  try {
    const db = openReadOnly(dbPath);
    if (!db) return undefined;
    try {
      const fingerprint = readFingerprint(db, identity);
      const cached = blockCache.get(cacheKey);
      if (cached !== undefined && cached.fingerprint === fingerprint) return cached.block;
      const block = renderProjectMemoryBlock(selectMemories(db, identity));
      blockCache.set(cacheKey, { fingerprint, block });
      return block;
    } finally {
      db.close();
    }
  } catch {
    // A corrupt, locked, or schema-drifted store must not break a spawn.
    blockCache.delete(cacheKey);
    return undefined;
  }
}

/** Open `context.db` read-only. Never throws. */
function openReadOnly(dbPath: string): SqliteDatabase | undefined {
  if (!existsSync(dbPath)) return undefined;
  try {
    // `createRequire` rather than `await import("node:sqlite")` so the caller
    // stays synchronous — this runs mid-`runAgent`, on every spawn. `node:sqlite`
    // is a builtin, so the require resolves under Node 22+ and Bun alike.
    const req = createRequire(import.meta.url);
    const sqlite = req("node:sqlite") as { DatabaseSync?: unknown };
    if (typeof sqlite.DatabaseSync !== "function") return undefined;
    const DatabaseSync = sqlite.DatabaseSync as new (
      path: string,
      options?: { readOnly?: boolean },
    ) => SqliteDatabase;
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    // node:sqlite unavailable (older Node), unreadable file, or locked store.
    return undefined;
  }
}

/**
 * Cheap change detector for the cache: count, max id, and max updated_at over
 * exactly the rows that render. Any pin, update, merge, or expiry moves it.
 */
function readFingerprint(db: SqliteDatabase, identity: string): string {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max_id, COALESCE(MAX(updated_at), 0) AS max_updated
         FROM memories
        WHERE project_path = ?
          AND status IN ${LIVE_STATUSES}
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(identity, Date.now()) as { n: number; max_id: number; max_updated: number } | undefined;
  if (!row) return "0|0|0";
  return `${row.n}|${row.max_id}|${row.max_updated}`;
}

/** Rows that render, in selection order: permanent, importance, reinforcement, id. */
function selectMemories(db: SqliteDatabase, identity: string): ProjectMemoryRow[] {
  const rows = db
    .prepare(
      `SELECT id, category, content, status, importance, last_seen_at, verified_at
         FROM memories
        WHERE project_path = ?
          AND status IN ${LIVE_STATUSES}
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY id ASC`,
    )
    .all(identity, Date.now()) as Array<Record<string, unknown>>;
  return rows.map(toRow).filter((row): row is ProjectMemoryRow => row !== undefined);
}

function toRow(raw: Record<string, unknown>): ProjectMemoryRow | undefined {
  const id = asNumber(raw.id);
  const category = typeof raw.category === "string" ? raw.category : undefined;
  const content = typeof raw.content === "string" ? raw.content : undefined;
  if (id === undefined || category === undefined || content === undefined) return undefined;
  return {
    id,
    category,
    content,
    status: typeof raw.status === "string" ? raw.status : "active",
    importance: asNumber(raw.importance) ?? null,
    lastSeenAt: asNumber(raw.last_seen_at) ?? null,
    verifiedAt: asNumber(raw.verified_at) ?? null,
  };
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/**
 * Trim to the token budget, then render. Two orderings, mirroring upstream:
 * `compareMemorySelectionPriority` decides WHO survives the budget, and
 * `memoryRenderOrder` decides the byte order of what survives.
 */
function renderProjectMemoryBlock(memories: ProjectMemoryRow[]): string | undefined {
  if (memories.length === 0) return undefined;

  const selectionOrder = [...memories].sort(compareSelectionPriority);
  let usedTokens = estimateTokens("<project-memory>\n</project-memory>");
  const seenCategories = new Set<string>();
  const categoryTagCost = new Map<string, number>();
  const selected: ProjectMemoryRow[] = [];

  for (const memory of selectionOrder) {
    const line = renderLine(memory);
    let cost = estimateTokens(`${line}\n`);
    if (!seenCategories.has(memory.category)) {
      let tags = categoryTagCost.get(memory.category);
      if (tags === undefined) {
        tags = estimateTokens(`<${memory.category}>\n</${memory.category}>\n`);
        categoryTagCost.set(memory.category, tags);
      }
      cost += tags;
    }
    if (usedTokens + cost > MEMORY_BUDGET_TOKENS) continue;
    usedTokens += cost;
    seenCategories.add(memory.category);
    selected.push(memory);
  }

  if (selected.length === 0) return undefined;

  const ordered = [...selected].sort(memoryRenderOrder);
  const lines = ["<project-memory>"];
  let openCategory: string | undefined;
  for (const memory of ordered) {
    if (memory.category !== openCategory) {
      if (openCategory !== undefined) lines.push(`</${openCategory}>`);
      openCategory = memory.category;
      lines.push(`<${openCategory}>`);
    }
    lines.push(renderLine(memory));
  }
  if (openCategory !== undefined) lines.push(`</${openCategory}>`);
  lines.push("</project-memory>");
  return lines.join("\n");
}

/** `#<id>: <content>` — the wire form agents address memories by. */
function renderLine(memory: ProjectMemoryRow): string {
  return `#${memory.id}: ${escapeXmlContent(memory.content)}`;
}

function compareSelectionPriority(left: ProjectMemoryRow, right: ProjectMemoryRow): number {
  if (left.status === "permanent" && right.status !== "permanent") return -1;
  if (right.status === "permanent" && left.status !== "permanent") return 1;

  const leftImportance = left.importance ?? Number.NEGATIVE_INFINITY;
  const rightImportance = right.importance ?? Number.NEGATIVE_INFINITY;
  const importanceDiff = rightImportance - leftImportance;
  if (importanceDiff !== 0) return importanceDiff;

  const leftReinforced = reinforcementAt(left);
  const rightReinforced = reinforcementAt(right);
  if (leftReinforced === null && rightReinforced === null) return left.id - right.id;
  if (leftReinforced === null) return 1;
  if (rightReinforced === null) return -1;
  return rightReinforced - leftReinforced;
}

/** The newer of "seen again" and "verified" — either path reinforces a memory. */
function reinforcementAt(memory: ProjectMemoryRow): number | null {
  const timestamps = [memory.lastSeenAt, memory.verifiedAt].filter(
    (value): value is number => value !== null,
  );
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function memoryRenderOrder(left: ProjectMemoryRow, right: ProjectMemoryRow): number {
  const leftPriority = CATEGORY_PRIORITY.indexOf(left.category);
  const rightPriority = CATEGORY_PRIORITY.indexOf(right.category);
  if (leftPriority >= 0 || rightPriority >= 0) {
    if (leftPriority < 0) return 1;
    if (rightPriority < 0) return -1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  } else if (left.category !== right.category) {
    return left.category < right.category ? -1 : 1;
  }
  return left.id - right.id;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function escapeXmlContent(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
