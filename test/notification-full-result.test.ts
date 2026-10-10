/**
 * notification-full-result.test.ts — バックグラウンド完了通知の <result> は全文を含む。
 *
 * 仕様: 親セッションに届く完了通知（`<task-notification>`）の `<result>` は
 * 500 文字（個別通知）・300 文字（グループ通知）で切り詰めず、サブエージェントの
 * 出力全文をそのまま含める。親が `get_subagent_result` を呼ばなくても
 * 通知だけで最終報告を全部読めることが目的。
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

// 旧・個別通知の上限 500 文字を十分に超える長さ。末尾マーカーが残れば全文到達の証拠。
const LONG_RESULT_A = `HEAD-A-UNIQUE-11111-${"x".repeat(800)}-TAIL-A-UNIQUE-98765`;
const LONG_RESULT_B = `HEAD-B-UNIQUE-22222-${"y".repeat(800)}-TAIL-B-UNIQUE-54321`;

function settledWith(text: string) {
	return { responseText: text, session: { dispose: vi.fn() }, aborted: false, steered: false } as any;
}

async function spawnBackground(tools: Map<string, any>, description: string) {
	const r = await tools.get("Agent").execute(
		"tc-spawn",
		{ prompt: "go", description, subagent_type: "general-purpose", run_in_background: true },
		undefined,
		undefined,
		ctx(),
	);
	const id = /Agent ID: (\S+)/.exec(textOf(r))?.[1];
	expect(id, "background spawn should surface an agent id").toBeTruthy();
	return id as string;
}

/** predicate に合う subagent-notification が届くまでポーリングして content を返す。 */
async function waitForNotification(pi: any, predicate: (msg: any) => boolean, timeoutMs = 8000) {
	const start = Date.now();
	for (;;) {
		const found = vi
			.mocked(pi.sendMessage)
			.mock.calls.find((c: any[]) => c[0]?.customType === "subagent-notification" && predicate(c[0]));
		if (found) return found[0].content as string;
		expect(Date.now() - start, "timed out waiting for subagent-notification").toBeLessThan(timeoutMs);
		await new Promise((r) => setTimeout(r, 100));
		await flush();
	}
}

const resultXmlOf = (content: string) => /<result>([\s\S]*)<\/result>/.exec(content)?.[1];

describe("background completion notification carries the full result", () => {
	afterEach(() => {
		delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
		vi.restoreAllMocks();
	});

	it("個別通知: 500 文字超の結果が切り詰められず全文届く", async () => {
		expect(LONG_RESULT_A.length).toBeGreaterThan(500);
		const { pi, tools, lifecycle } = makePi();
		subagentsExtension(pi);
		vi.mocked(runAgent).mockResolvedValue(settledWith(LONG_RESULT_A));

		const id = await spawnBackground(tools, "full-result individual agent");

		const content = await waitForNotification(pi, (m) => String(m.content).includes(id));

		// 全文そのまま（先頭・末尾マーカーで確認）。旧仕様の切り詰め文言は出ない。
		expect(content).toContain(LONG_RESULT_A);
		expect(content).toContain("-TAIL-A-UNIQUE-98765");
		expect(content).not.toContain("truncated");
		expect(resultXmlOf(content)).toBe(LONG_RESULT_A);

		// details.resultPreview は画面描画用に 500 文字で切り詰め（TUI 自衛の保証）。
		const sent = vi
			.mocked(pi.sendMessage)
			.mock.calls.find((c: any[]) => String(c[0]?.content).includes(id))?.[0];
		expect(sent?.details?.resultPreview).toBe(`${LONG_RESULT_A.slice(0, 500)}…`);

		await lifecycle.get("session_shutdown")?.();
	});

	it("グループ通知: 300 文字超の結果が2件とも切り詰められず全文届く", async () => {
		expect(LONG_RESULT_A.length).toBeGreaterThan(300);
		expect(LONG_RESULT_B.length).toBeGreaterThan(300);
		const { pi, tools, lifecycle } = makePi();
		subagentsExtension(pi);
		vi.mocked(runAgent)
			.mockResolvedValueOnce(settledWith(LONG_RESULT_A))
			.mockResolvedValueOnce(settledWith(LONG_RESULT_B));

		// 同じ 100ms バッチ窓に 2 件投入 → smart グループ通知になる。
		const p1 = spawnBackground(tools, "full-result group agent A");
		const p2 = spawnBackground(tools, "full-result group agent B");
		const [idA, idB] = await Promise.all([p1, p2]);

		const content = await waitForNotification(pi, (m) =>
			String(m.content).includes("Background agent group completed"),
		);

		expect(content).toContain(idA);
		expect(content).toContain(idB);
		expect(content).toContain(LONG_RESULT_A);
		expect(content).toContain(LONG_RESULT_B);
		expect(content).toContain("-TAIL-A-UNIQUE-98765");
		expect(content).toContain("-TAIL-B-UNIQUE-54321");
		expect(content).not.toContain("truncated");
		// 全文入りなので「Use get_subagent_result for full output.」の但し書きは付けない。
		expect(content).not.toContain("Use get_subagent_result for full output");

		// details は画面描画用に 300 文字で切り詰め（TUI 自衛の保証）。
		// 完了順が逆転し得るため、順序を仮定せず両方のプレビューが揃うことを確認する。
		const sent = vi
			.mocked(pi.sendMessage)
			.mock.calls.find((c: any[]) =>
				String(c[0]?.content).includes("Background agent group completed"),
			)?.[0];
		const previews = [sent?.details?.resultPreview, sent?.details?.others?.[0]?.resultPreview];
		expect(sent?.details?.others).toHaveLength(1);
		expect(previews).toContain(`${LONG_RESULT_A.slice(0, 300)}…`);
		expect(previews).toContain(`${LONG_RESULT_B.slice(0, 300)}…`);

		await lifecycle.get("session_shutdown")?.();
	});

	it("特殊文字はエスケープされて安全に出力される", async () => {
		const SPECIAL_RESULT = "a & b <tag> c > d";
		const { pi, tools, lifecycle } = makePi();
		subagentsExtension(pi);
		vi.mocked(runAgent).mockResolvedValue(settledWith(SPECIAL_RESULT));

		const id = await spawnBackground(tools, "escape-check agent");

		const content = await waitForNotification(pi, (m) => String(m.content).includes(id));

		// <result> 内はエスケープ済み。生の <tag> は出ない。
		expect(resultXmlOf(content)).toBe("a &amp; b &lt;tag&gt; c &gt; d");
		expect(content).toContain("a &amp; b &lt;tag&gt; c &gt; d");
		expect(content).not.toContain("<tag>");

		await lifecycle.get("session_shutdown")?.();
	});
});
