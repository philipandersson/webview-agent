// Pretty-printing for eval runs. Imported by runner.ts — keeps the runner
// focused on "invoke agent, score assertions" and this file focused on
// "turn a CaseResult into terminal output".

import type { AgentUsage } from "../src/agent";
import type { Assertion, ToolCallSummary } from "./cases";

export type CaseResult = {
  id: string;
  wallMs: number;
  usage: AgentUsage;
  toolCalls: ToolCallSummary[];
  costUsd: number;
  scriptsWritten: string[];
  assertions: Assertion[];
  passed: number;
  total: number;
  passRate: number;
  finalTextLen: number;
  error?: string;
};

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export function printCase(r: CaseResult): void {
  const { usage: u } = r;
  console.log(`\n━━━ ${r.id} ━━━`);
  console.log(
    `  wall: ${fmtMs(r.wallMs)}   turns: ${u.turns}   tok in/out/cached/reason: ${u.inputTokens} / ${u.outputTokens} / ${u.cachedInputTokens} / ${u.reasoningTokens}   ≈$${r.costUsd.toFixed(4)}`,
  );
  const scriptsList = r.scriptsWritten.slice(0, 3).join(", ");
  const scriptsSuffix = r.scriptsWritten.length > 3 ? ", …" : "";
  console.log(`  scripts written: ${r.scriptsWritten.length} (${scriptsList}${scriptsSuffix})`);
  const tcList = r.toolCalls.map((t) => `${t.name}×${t.count}`).join(", ");
  console.log(`  tool calls: ${tcList || "(none)"}`);
  console.log(`  final text: ${r.finalTextLen} chars`);
  if (r.error) console.log(`  ERROR: ${r.error}`);
  for (const a of r.assertions) {
    const mark = a.pass ? "✓" : "✗";
    const det = a.detail ? ` — ${a.detail}` : "";
    console.log(`    ${mark} ${a.name}${det}`);
  }
  console.log(`  score: ${r.passed}/${r.total} (${Math.round(r.passRate * 100)}%)`);
}

export function printSummary(results: CaseResult[]): void {
  const totals = results.reduce(
    (acc, r) => ({
      wallMs: acc.wallMs + r.wallMs,
      inTok: acc.inTok + r.usage.inputTokens,
      outTok: acc.outTok + r.usage.outputTokens,
      cost: acc.cost + r.costUsd,
      passed: acc.passed + r.passed,
      total: acc.total + r.total,
    }),
    { wallMs: 0, inTok: 0, outTok: 0, cost: 0, passed: 0, total: 0 },
  );

  const rule = "━".repeat(60);
  console.log(`\n${rule}`);
  console.log("  id                    wall     tok(in/out)        $       pass");
  console.log(rule);
  for (const r of results) {
    console.log(
      `  ${r.id.padEnd(22)}` +
        `${fmtMs(r.wallMs).padEnd(8)}` +
        `${`${r.usage.inputTokens}/${r.usage.outputTokens}`.padEnd(18)}` +
        `$${r.costUsd.toFixed(3).padEnd(7)}` +
        `${r.passed}/${r.total}`,
    );
  }
  console.log(rule);
  const pctTotal = Math.round((totals.passed / totals.total) * 100);
  console.log(
    `  TOTAL                 ${fmtMs(totals.wallMs).padEnd(8)}` +
      `${`${totals.inTok}/${totals.outTok}`.padEnd(18)}` +
      `$${totals.cost.toFixed(3).padEnd(7)}` +
      `${totals.passed}/${totals.total} (${pctTotal}%)`,
  );
}
