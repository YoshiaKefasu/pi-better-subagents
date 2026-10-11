/**
 * concurrency-print-mode-e2e.test.ts — does `maxConcurrent` actually serialize a
 * turn's `Agent` calls, end to end?
 *
 * The unit and wiring tests call the tool's `execute` directly, twice, without
 * awaiting the first. That MODELS pi's parallel dispatch; it does not prove the
 * real agent loop behaves that way. This drives a real headless pi session, a
 * real assistant turn emitting TWO `Agent` tool calls in ONE message, and lets
 * pi's own `executeToolCallsParallel` dispatch them through `Promise.all`.
 *
 * Overlap is measured, not inferred: each child's faux model call increments an
 * in-flight counter, holds for a real interval, then decrements. Two agents
 * running at once drive `maxInFlight` to 2; serialized ones leave it at 1.
 *
 * The roomy control case is what makes the limited one meaningful — it proves
 * the detector can see parallelism at all, so `maxInFlight === 1` is a result
 * rather than a broken probe.
 *
 * Every spawn is detached now, so a queued agent does not merely run later — it
 * does not START at all, which is a strictly stronger signal than the overlap
 * counter alone. The parent fetches each result by the id its own receipt
 * handed back, which is the only way a detached result reaches it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  type PrintModeRun,
  runPrintMode,
  toolResultsNamed,
} from "./helpers/print-mode-runner.js";

// Real pi-mono: loader, dynamic extension import, three live sessions.
vi.setConfig({ testTimeout: 60_000 });

const LIVE = /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");

/** How long each child holds the model call — long enough to overlap detectably. */
const CHILD_HOLD_MS = 120;

describe.skipIf(LIVE)("maxConcurrent e2e (real pi agent loop)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function projectDir(settings: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-conc-e2e-"));
    tmpDirs.push(dir);
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "subagents.json"),
      JSON.stringify({ outputTranscript: false, ...settings }),
    );
    return dir;
  }

  /**
   * One parent turn emitting two Agent calls in a single message — the shape pi
   * dispatches through Promise.all — plus a child responder that measures how
   * many children are in flight at once.
   */
  async function twoDetachedAgents(settings: Record<string, unknown>) {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];

    run = await runPrintMode({
      prompt: "Delegate two independent jobs and report both.",
      cwd: projectDir(settings),
      live: false, // scripted on purpose: a real model may not emit both calls
      respond: async (context: Context) => {
        // Routed on the session's own prompt, not on its tool set: the root
        // session's faux `context.tools` is empty in this runner, which is what
        // left this file's routing inverted before.
        const first = context.messages.find((m) => m.role === "user");
        const firstContent = first?.content;
        const firstText = typeof firstContent === "string"
          ? firstContent
          : ((firstContent ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
        if (firstText.includes("Delegate two independent jobs")) {
          const spawned = context.messages.filter(
            m => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
          );
          const polled = context.messages.filter(
            m => m.role === "toolResult" && (m as { toolName?: string }).toolName === "get_subagent_result",
          );
          if (polled.length >= 2) return "Both jobs are done.";
          if (spawned.length === 0) {
            // TWO tool calls, ONE assistant message — exactly what the Agent tool
            // description tells the model to send for parallel work.
            return [
              agentCall({ prompt: "JOB-ALPHA", description: "alpha" }),
              agentCall({ prompt: "JOB-BETA", description: "beta" }),
            ];
          }
          // Fetch each by the id its own receipt handed back. One call per turn
          // keeps the sequence unambiguous; `wait: true` is what a real
          // orchestrator uses for work it needs before continuing.
          const index = polled.length;
          const receipt = (spawned[index].content as Array<{ text?: string }>)
            .map(b => b.text ?? "").join("");
          const id = /Agent ID: (\S+)/.exec(receipt)?.[1];
          if (!id) throw new Error(`No agent ID in receipt ${index}: ${receipt}`);
          return {
            type: "toolCall",
            id: `poll-${index}`,
            name: "get_subagent_result",
            arguments: { agent_id: id, wait: true },
          } as never;
        }

        // A child. Hold the model call so genuine overlap is observable.
        const label = JSON.stringify(context.messages).includes("JOB-ALPHA") ? "alpha" : "beta";
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(`start:${label}`);
        await new Promise(r => setTimeout(r, CHILD_HOLD_MS));
        order.push(`end:${label}`);
        inFlight--;
        return `${label.toUpperCase()}-RESULT`;
      },
    });

    return { maxInFlight, order };
  }

  it("runs a turn's two Agent calls one at a time when the limit is 1", async () => {
    const { maxInFlight, order } = await twoDetachedAgents({ maxConcurrent: 1 });

    expect(maxInFlight).toBe(1);
    // Strictly serialized: the first child ends before the second begins.
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(order[0].replace("start:", "end:"));

    // Serialization must not cost anyone their result — the second agent still
    // runs once the slot frees, and the parent reads both by id.
    const results = toolResultsNamed(run!.parentSession, "get_subagent_result").join("\n");
    expect(results).toContain("ALPHA-RESULT");
    expect(results).toContain("BETA-RESULT");

    // And the turn itself finished — the parent answered after both returned,
    // rather than the second call being left parked on a slot nobody freed.
    expect(run!.responseText).toContain("Both jobs are done.");
  });

  // The control. Without this, the assertion above could pass on a detector
  // that never observes overlap in the first place.
  it("runs them concurrently when the pool is roomy — the detector works", async () => {
    const { maxInFlight, order } = await twoDetachedAgents({ maxConcurrent: 10 });

    expect(maxInFlight).toBe(2);
    // Interleaved: both start before either ends.
    expect(order.slice(0, 2).every(e => e.startsWith("start:"))).toBe(true);

    const results = toolResultsNamed(run!.parentSession, "get_subagent_result").join("\n");
    expect(results).toContain("ALPHA-RESULT");
    expect(results).toContain("BETA-RESULT");
  });
});
