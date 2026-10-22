// Node (V8) reference run for the solve ladder (plan 036 R5.1). Runs the same
// cases through the same code as the browser worker (solveLadderRun.ts) and
// records the parity reference that scripts/verify-solve-ladder.mjs compares
// browser results against. Re-run it only when the solver or the fixtures
// change; each entry is keyed by the fixture fingerprint.
//
// Usage: pnpm build:core && pnpm exec tsx scripts/solve-ladder-node.ts [--cases=id,id] [--rungs=30k,75k]
// Env: LADDER_REFERENCE_PATH (default docs/validation/solve-ladder/reference-node.json)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ladderCases } from "../apps/openfea-web/src/workers/solveLadderFixtures";
import { ladderCaseId, runLadderCase } from "../apps/openfea-web/src/workers/solveLadderRun";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const referencePath = process.env.LADDER_REFERENCE_PATH ?? join(repoRoot, "docs/validation/solve-ladder/reference-node.json");
const argument = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3).split(",");
const caseFilter = argument("cases");
const rungFilter = argument("rungs");

type ReferenceFile = { generatedBy: string; runtime: Record<string, unknown>; cases: Record<string, unknown> };
const reference: ReferenceFile = existsSync(referencePath)
  ? (JSON.parse(readFileSync(referencePath, "utf8")) as ReferenceFile)
  : { generatedBy: "scripts/solve-ladder-node.ts", runtime: {}, cases: {} };
reference.runtime = {
  node: process.version,
  v8: process.versions.v8,
  platform: `${process.platform}-${process.arch}`,
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  totalMemoryBytes: totalmem()
};

for (const entry of ladderCases()) {
  const caseId = ladderCaseId(entry);
  if (caseFilter && !caseFilter.includes(caseId)) continue;
  if (rungFilter && !rungFilter.includes(entry.rung)) continue;
  const started = Date.now();
  const result = runLadderCase(entry);
  console.log(`[node] ${caseId} ${result.ok ? "ok" : `FAIL ${result.error.split("\n")[0]}`} in ${Math.round((Date.now() - started) / 1000)} s`);
  reference.cases[caseId] = { ...result, measuredAt: new Date().toISOString() };
  mkdirSync(dirname(referencePath), { recursive: true });
  writeFileSync(referencePath, `${JSON.stringify(reference, null, 2)}\n`);
}
console.log(`[node] reference written to ${referencePath}`);
