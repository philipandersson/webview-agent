// Side-by-side diff of two eval run JSON files. Use after a prompt tweak
// or code change to see whether time / cost / accuracy actually improved.
//
// Usage:
//   bun evals/compare.ts <before.json> <after.json>
//   bun evals/compare.ts                             # auto-pick the two
//                                                    # most recent in evals/results/
//
// Exits 0 regardless of direction — this is reporting, not CI-gating.

import { fmtMs, type CaseResult } from "./report";

type RunFile = {
  at: string;
  model: string | null;
  prices: { in: number; out: number; cached: number };
  results: CaseResult[];
};

async function loadRun(path: string): Promise<RunFile> {
  const text = await Bun.file(path).text();
  return JSON.parse(text) as RunFile;
}

async function mostRecentTwo(): Promise<[string, string]> {
  const glob = new Bun.Glob("*.json");
  const files: string[] = [];
  for await (const f of glob.scan({ cwd: "evals/results" })) files.push(f);
  if (files.length < 2) {
    throw new Error(`need ≥2 run files in evals/results/ (found ${files.length})`);
  }
  files.sort(); // ISO timestamps sort chronologically
  const after = `evals/results/${files[files.length - 1]}`;
  const before = `evals/results/${files[files.length - 2]}`;
  return [before, after];
}

type Delta = { abs: number; pct: number };

function delta(before: number, after: number): Delta {
  const abs = after - before;
  const pct = before === 0 ? 0 : (abs / before) * 100;
  return { abs, pct };
}

function signed(n: number, format: (abs: number) => string): string {
  if (n === 0) return `   ${format(0)}`;
  const sign = n > 0 ? "+" : "-";
  return `${sign}${format(Math.abs(n))}`;
}

function pctStr(pct: number): string {
  if (pct === 0) return "  0%";
  const rounded = Math.round(pct);
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

type Row = {
  id: string;
  wallBefore: number;
  wallAfter: number;
  costBefore: number;
  costAfter: number;
  inTokBefore: number;
  inTokAfter: number;
  outTokBefore: number;
  outTokAfter: number;
  passBefore: string;
  passAfter: string;
  toolCallsBefore: string;
  toolCallsAfter: string;
};

function buildRow(before: CaseResult, after: CaseResult): Row {
  const toolSummary = (r: CaseResult) =>
    (r.toolCalls ?? []).map((t) => `${t.name}×${t.count}`).join(", ") || "(none)";
  return {
    id: before.id,
    wallBefore: before.wallMs,
    wallAfter: after.wallMs,
    costBefore: before.costUsd,
    costAfter: after.costUsd,
    inTokBefore: before.usage.inputTokens,
    inTokAfter: after.usage.inputTokens,
    outTokBefore: before.usage.outputTokens,
    outTokAfter: after.usage.outputTokens,
    passBefore: `${before.passed}/${before.total}`,
    passAfter: `${after.passed}/${after.total}`,
    toolCallsBefore: toolSummary(before),
    toolCallsAfter: toolSummary(after),
  };
}

function printCase(row: Row): void {
  const dWall = delta(row.wallBefore, row.wallAfter);
  const dCost = delta(row.costBefore, row.costAfter);
  const dIn = delta(row.inTokBefore, row.inTokAfter);
  const dOut = delta(row.outTokBefore, row.outTokAfter);

  console.log(`\n━━━ ${row.id} ━━━`);
  console.log(
    `  wall:   ${fmtMs(row.wallBefore).padEnd(8)} → ${fmtMs(row.wallAfter).padEnd(8)}   ${signed(dWall.abs, (n) => fmtMs(Math.abs(n)))}  (${pctStr(dWall.pct)})`,
  );
  console.log(
    `  cost:   $${row.costBefore.toFixed(4).padEnd(7)} → $${row.costAfter.toFixed(4).padEnd(7)}   ${signed(dCost.abs, (n) => `$${Math.abs(n).toFixed(4)}`)}  (${pctStr(dCost.pct)})`,
  );
  console.log(
    `  tok in:  ${String(row.inTokBefore).padEnd(8)} → ${String(row.inTokAfter).padEnd(8)}   ${signed(dIn.abs, (n) => String(Math.abs(n)))}  (${pctStr(dIn.pct)})`,
  );
  console.log(
    `  tok out: ${String(row.outTokBefore).padEnd(8)} → ${String(row.outTokAfter).padEnd(8)}   ${signed(dOut.abs, (n) => String(Math.abs(n)))}  (${pctStr(dOut.pct)})`,
  );
  console.log(`  pass:   ${row.passBefore} → ${row.passAfter}`);
  console.log(`  tools before: ${row.toolCallsBefore}`);
  console.log(`  tools after:  ${row.toolCallsAfter}`);
}

function printSummary(rows: Row[]): void {
  const sum = rows.reduce(
    (acc, r) => ({
      wallBefore: acc.wallBefore + r.wallBefore,
      wallAfter: acc.wallAfter + r.wallAfter,
      costBefore: acc.costBefore + r.costBefore,
      costAfter: acc.costAfter + r.costAfter,
      inBefore: acc.inBefore + r.inTokBefore,
      inAfter: acc.inAfter + r.inTokAfter,
      outBefore: acc.outBefore + r.outTokBefore,
      outAfter: acc.outAfter + r.outTokAfter,
    }),
    { wallBefore: 0, wallAfter: 0, costBefore: 0, costAfter: 0, inBefore: 0, inAfter: 0, outBefore: 0, outAfter: 0 },
  );
  const rule = "━".repeat(60);
  console.log(`\n${rule}`);
  console.log("  TOTALS");
  console.log(rule);
  console.log(
    `  wall: ${fmtMs(sum.wallBefore)} → ${fmtMs(sum.wallAfter)}   (${pctStr(delta(sum.wallBefore, sum.wallAfter).pct)})`,
  );
  console.log(
    `  cost: $${sum.costBefore.toFixed(3)} → $${sum.costAfter.toFixed(3)}   (${pctStr(delta(sum.costBefore, sum.costAfter).pct)})`,
  );
  console.log(
    `  tok:  ${sum.inBefore}/${sum.outBefore} → ${sum.inAfter}/${sum.outAfter}`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  let beforePath: string;
  let afterPath: string;
  if (args.length === 2) {
    beforePath = args[0]!;
    afterPath = args[1]!;
  } else if (args.length === 0) {
    [beforePath, afterPath] = await mostRecentTwo();
    console.log(`Comparing (auto-picked):\n  before: ${beforePath}\n  after:  ${afterPath}`);
  } else {
    console.error("Usage: bun evals/compare.ts [<before.json> <after.json>]");
    process.exit(2);
  }

  const [before, after] = await Promise.all([loadRun(beforePath), loadRun(afterPath)]);

  const afterById = new Map(after.results.map((r) => [r.id, r]));
  const rows: Row[] = [];
  const onlyBefore: string[] = [];
  const onlyAfter = new Set(afterById.keys());

  for (const b of before.results) {
    const a = afterById.get(b.id);
    if (!a) {
      onlyBefore.push(b.id);
      continue;
    }
    rows.push(buildRow(b, a));
    onlyAfter.delete(b.id);
  }

  for (const row of rows) printCase(row);
  if (rows.length > 1) printSummary(rows);

  if (onlyBefore.length) console.log(`\n(only in before: ${onlyBefore.join(", ")})`);
  if (onlyAfter.size) console.log(`(only in after:  ${[...onlyAfter].join(", ")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
