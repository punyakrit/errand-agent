import { mkdirSync, writeFileSync } from "node:fs";
import { evalTable } from "./report.ts";
import { runScenario } from "./runner.ts";
import { SCENARIOS } from "./scenarios/index.ts";
import { runSweep } from "./sweep.ts";

// `npm run eval`. Runs offline and writes the generated table.
const results = [];
for (const scenario of SCENARIOS) results.push(await runScenario(scenario));
const sweep = await runSweep(500);

mkdirSync("docs", { recursive: true });
writeFileSync("docs/eval-table.md", evalTable(results, sweep, "npm run eval"));
writeFileSync("docs/eval-results.json", `${JSON.stringify({ results, sweep }, null, 2)}\n`);

for (const result of results) {
  console.log(`${result.pass ? "pass" : "FAIL"}  ${result.id}. ${result.name}${result.pass ? "" : `  -> ${result.notes}`}`);
}
const passed = results.filter((result) => result.pass).length;
console.log(`\n${passed} of ${results.length} scenarios passed`);
console.log(`Sweep: ${sweep.passed} of ${sweep.seeds} seeds passed the invariants`);
console.log(sweep.outcomes);
for (const failure of sweep.failures.slice(0, 5)) console.log(`  seed ${failure.seed}: ${failure.problem}`);

process.exit(passed === results.length && sweep.failed === 0 ? 0 : 1);
