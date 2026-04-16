// Run one or all eval cases end-to-end with the real agent + real sites,
// measure wall time + token usage, score structural and outcome assertions,
// print a summary, persist a JSON record.
//
// Usage:
//   bun evals/runner.ts                 # run all
//   bun evals/runner.ts car-search      # run one case by id
//   bun evals/runner.ts --model gpt-5.4 # override model
//
// Cost estimate: each case runs the agent up to 40 turns × 1 API call each,
// plus tool calls. Expect $0.10 - $1.00 per case on GPT-5-class models.

import { Agent, type AgentUsage } from "../src/agent";
import { envNum } from "../src/env";
import { cases, type EvalCase, type Assertion, type ToolCallSummary } from "./cases";

// Placeholder rate card — override via env if needed.
const DEFAULT_PRICE_IN_PER_MTOK = envNum("EVAL_PRICE_IN", 2.5); // $/Mtok
const DEFAULT_PRICE_OUT_PER_MTOK = envNum("EVAL_PRICE_OUT", 10);
const DEFAULT_PRICE_CACHED_PER_MTOK = envNum("EVAL_PRICE_CACHED", 0.25);
const PER_CASE_TIMEOUT_MS = envNum("EVAL_TIMEOUT_MS", 10 * 60 * 1000);

type CaseResult = {
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

function tallyToolCalls(history: readonly unknown[]): ToolCallSummary[] {
  const counts = new Map<string, number>();
  for (const h of history) {
    if (
      h &&
      typeof h === "object" &&
      (h as { type?: string }).type === "function_call"
    ) {
      const name = (h as { name?: string }).name ?? "?";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

async function listWorkspaceScripts(): Promise<string[]> {
  const glob = new Bun.Glob("*.ts");
  const out: string[] = [];
  for await (const f of glob.scan({ cwd: "workspace/scripts" })) out.push(f);
  return out.sort();
}

function estimateCostUsd(u: AgentUsage): number {
  const fresh = u.inputTokens - u.cachedInputTokens;
  const cost =
    (fresh * DEFAULT_PRICE_IN_PER_MTOK) / 1e6 +
    (u.cachedInputTokens * DEFAULT_PRICE_CACHED_PER_MTOK) / 1e6 +
    (u.outputTokens * DEFAULT_PRICE_OUT_PER_MTOK) / 1e6;
  return Math.round(cost * 10000) / 10000;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`eval timeout after ${ms}ms`)), ms),
    ),
  ]);
}

async function runOne(c: EvalCase, model?: string): Promise<CaseResult> {
  const before = new Set(await listWorkspaceScripts());
  const agent = new Agent(undefined, { silent: true, ...(model ? { model } : {}) });

  const t0 = performance.now();
  let error: string | undefined;
  try {
    await withTimeout(agent.run(c.prompt), PER_CASE_TIMEOUT_MS);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const wallMs = Math.round(performance.now() - t0);

  const afterAll = await listWorkspaceScripts();
  const newScripts = afterAll.filter((f) => !before.has(f));
  const scriptRecords = await Promise.all(
    newScripts.map(async (f) => ({
      path: `workspace/scripts/${f}`,
      content: await Bun.file(`workspace/scripts/${f}`).text(),
    })),
  );

  const usage = agent.getUsage();
  const costUsd = estimateCostUsd(usage);
  const finalText = agent.getLastFinalText();
  const toolCalls = tallyToolCalls(agent.getHistory());

  const structural = c.structural(scriptRecords, toolCalls);
  const outcome = c.outcome(finalText);
  const assertions = [
    ...structural.map((a) => ({ ...a, name: `[struct] ${a.name}` })),
    ...outcome.map((a) => ({ ...a, name: `[outcome] ${a.name}` })),
  ];
  const passed = assertions.filter((a) => a.pass).length;
  const total = assertions.length;

  return {
    id: c.id,
    wallMs,
    usage,
    toolCalls,
    costUsd,
    scriptsWritten: newScripts,
    assertions,
    passed,
    total,
    passRate: Math.round((passed / total) * 100) / 100,
    finalTextLen: finalText.length,
    ...(error ? { error } : {}),
  };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function printCase(r: CaseResult): void {
  console.log(`\n━━━ ${r.id} ━━━`);
  console.log(
    `  wall: ${fmtMs(r.wallMs)}   turns: ${r.usage.turns}   tok in/out/cached/reason: ${r.usage.inputTokens} / ${r.usage.outputTokens} / ${r.usage.cachedInputTokens} / ${r.usage.reasoningTokens}   ≈$${r.costUsd.toFixed(4)}`,
  );
  console.log(`  scripts written: ${r.scriptsWritten.length} (${r.scriptsWritten.slice(0, 3).join(", ")}${r.scriptsWritten.length > 3 ? ", …" : ""})`);
  console.log(`  tool calls: ${r.toolCalls.map((t) => `${t.name}×${t.count}`).join(", ") || "(none)"}`);
  console.log(`  final text: ${r.finalTextLen} chars`);
  if (r.error) console.log(`  ERROR: ${r.error}`);
  for (const a of r.assertions) {
    const mark = a.pass ? "✓" : "✗";
    const det = a.detail ? ` — ${a.detail}` : "";
    console.log(`    ${mark} ${a.name}${det}`);
  }
  console.log(`  score: ${r.passed}/${r.total} (${Math.round(r.passRate * 100)}%)`);
}

function printSummary(results: CaseResult[]): void {
  const totals = results.reduce(
    (acc, r) => ({
      wallMs: acc.wallMs + r.wallMs,
      turns: acc.turns + r.usage.turns,
      inTok: acc.inTok + r.usage.inputTokens,
      outTok: acc.outTok + r.usage.outputTokens,
      cached: acc.cached + r.usage.cachedInputTokens,
      reasoning: acc.reasoning + r.usage.reasoningTokens,
      cost: acc.cost + r.costUsd,
      passed: acc.passed + r.passed,
      total: acc.total + r.total,
    }),
    { wallMs: 0, turns: 0, inTok: 0, outTok: 0, cached: 0, reasoning: 0, cost: 0, passed: 0, total: 0 },
  );

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  id                    wall     tok(in/out)        $       pass");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const r of results) {
    const id = r.id.padEnd(22);
    const wall = fmtMs(r.wallMs).padEnd(8);
    const tok = `${r.usage.inputTokens}/${r.usage.outputTokens}`.padEnd(18);
    const cost = `$${r.costUsd.toFixed(3)}`.padEnd(8);
    const pass = `${r.passed}/${r.total}`;
    console.log(`  ${id}${wall}${tok}${cost}${pass}`);
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    `  TOTAL                 ${fmtMs(totals.wallMs).padEnd(8)}${`${totals.inTok}/${totals.outTok}`.padEnd(18)}$${totals.cost.toFixed(3).padEnd(7)}${totals.passed}/${totals.total} (${Math.round((totals.passed / totals.total) * 100)}%)`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  let modelOverride: string | undefined;
  const selected: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--model") modelOverride = args[++i];
    else selected.push(a);
  }
  const targets = selected.length
    ? cases.filter((c) => selected.includes(c.id))
    : cases;
  if (targets.length === 0) {
    console.error(`no matching cases. available: ${cases.map((c) => c.id).join(", ")}`);
    process.exit(2);
  }

  console.log(`Running ${targets.length} case(s): ${targets.map((c) => c.id).join(", ")}`);
  console.log(
    `Model: ${modelOverride ?? process.env.OPENAI_MODEL ?? "(default)"}   Prices: in=$${DEFAULT_PRICE_IN_PER_MTOK}/Mtok out=$${DEFAULT_PRICE_OUT_PER_MTOK}/Mtok cached=$${DEFAULT_PRICE_CACHED_PER_MTOK}/Mtok   Timeout: ${fmtMs(PER_CASE_TIMEOUT_MS)}/case`,
  );

  const results: CaseResult[] = [];
  for (const c of targets) {
    const r = await runOne(c, modelOverride);
    printCase(r);
    results.push(r);
  }

  printSummary(results);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `evals/results/${stamp}.json`;
  await Bun.write(
    outPath,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        model: modelOverride ?? process.env.OPENAI_MODEL ?? null,
        prices: {
          in: DEFAULT_PRICE_IN_PER_MTOK,
          out: DEFAULT_PRICE_OUT_PER_MTOK,
          cached: DEFAULT_PRICE_CACHED_PER_MTOK,
        },
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nSaved ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
