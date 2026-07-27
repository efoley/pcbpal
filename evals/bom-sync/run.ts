/**
 * BOM-sync matching eval runner.
 *
 *   bun evals/bom-sync/run.ts                 # score all fixtures, gate vs baseline
 *   bun evals/bom-sync/run.ts --accept-baseline
 *
 * Fully deterministic and offline: no LLM, no network. Each fixture provides a
 * schematic (a minimal .kicad_sch parsed by the shipped readSchematicComponents,
 * or a components.json parsed component list), a pcbpal BOM, and a golden
 * schematic↔BOM correspondence. We run the pure `matchSchematicToBom` matcher
 * lifted from src/commands/bom/sync.ts and score its output against the golden.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { matchSchematicToBom, type SchBomMatch } from "../../src/commands/bom/sync.js";
import { BomDatabase } from "../../src/schemas/bom.js";
import { type KicadComponent, readSchematicComponents } from "../../src/services/kicad.js";
import {
  type Baseline,
  type CaseLine,
  diffBaseline,
  loadBaseline,
  writeBaseline,
} from "../src/shared/gate.js";
import { type BomSyncScore, GoldenMatch, scoreBomSync } from "./score.js";

const SUITE_DIR = import.meta.dir;
const FIXTURES_DIR = join(SUITE_DIR, "fixtures");
const BASELINE_PATH = join(SUITE_DIR, "baseline.json");

const GATE = { headlineDropEps: 0.05, mustStayTrue: ["exact"] };

async function loadComponents(fixtureDir: string): Promise<KicadComponent[]> {
  const jsonPath = join(fixtureDir, "components.json");
  if (existsSync(jsonPath)) {
    return JSON.parse(await readFile(jsonPath, "utf-8")) as KicadComponent[];
  }
  // Falls back to parsing every .kicad_sch in the fixture dir (usually one).
  return readSchematicComponents(fixtureDir);
}

export interface FixtureResult {
  fixture: string;
  score: BomSyncScore;
  predicted: SchBomMatch;
}

export async function runFixture(fixtureDir: string): Promise<FixtureResult> {
  const components = await loadComponents(fixtureDir);
  const bom = BomDatabase.parse(JSON.parse(await readFile(join(fixtureDir, "bom.json"), "utf-8")));
  const golden = GoldenMatch.parse(
    JSON.parse(await readFile(join(fixtureDir, "golden.json"), "utf-8")),
  );
  const predicted = matchSchematicToBom(components, bom.entries);
  const score = scoreBomSync(golden, predicted);
  return { fixture: fixtureDir.split("/").pop() ?? fixtureDir, score, predicted };
}

function caseLine(r: FixtureResult): CaseLine {
  return {
    key: `bom-sync:${r.fixture}`,
    headline: r.score.headline,
    metrics: {
      exact: r.score.exact,
      pair_f1: r.score.pair.f1,
      pair_precision: r.score.pair.precision,
      pair_recall: r.score.pair.recall,
    },
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function renderTable(results: FixtureResult[]): string {
  const header = "| fixture | headline | pair F1 | P | R | exact |\n|---|---:|---:|---:|---:|:--:|";
  const rows = results.map((r) => {
    const s = r.score;
    return `| ${r.fixture} | ${pct(s.headline)} | ${pct(s.pair.f1)} | ${pct(s.pair.precision)} | ${pct(s.pair.recall)} | ${s.exact ? "yes" : "NO"} |`;
  });
  return [header, ...rows].join("\n");
}

async function main(): Promise<number> {
  const acceptBaseline = process.argv.includes("--accept-baseline");
  const json = process.argv.includes("--json");

  const entries = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const results: FixtureResult[] = [];
  for (const name of entries) {
    process.stderr.write(`• ${name} … `);
    const r = await runFixture(join(FIXTURES_DIR, name));
    results.push(r);
    process.stderr.write(`headline=${r.score.headline.toFixed(3)} exact=${r.score.exact}\n`);
  }

  const cases = results.map(caseLine);
  const baseline: Baseline = await loadBaseline(BASELINE_PATH);
  const diff = diffBaseline(cases, baseline, GATE);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ results: results.map((r) => ({ fixture: r.fixture, score: r.score })), regressions: diff.regressions, newCases: diff.newCases }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${renderTable(results)}\n\n`);
  }

  if (acceptBaseline) {
    await writeBaseline(BASELINE_PATH, { ...baseline, ...diff.current });
    process.stdout.write(`Baseline updated: ${cases.length} case(s).\n`);
    return 0;
  }

  if (diff.newCases.length > 0) {
    process.stderr.write(
      `\n${diff.newCases.length} new case(s) with no baseline: ${diff.newCases.join(", ")}\n`,
    );
    process.stderr.write("Run with --accept-baseline to record them.\n");
  }
  if (diff.regressions.length > 0) {
    process.stderr.write(`\n${diff.regressions.length} regression(s) vs baseline:\n`);
    for (const r of diff.regressions)
      process.stderr.write(`  ✗ ${r.key}: ${r.reasons.join("; ")}\n`);
    return 1;
  }
  // A fixture whose golden isn't reproduced exactly is a hard failure even on a
  // fresh baseline — this suite is deterministic, so exact is always expected.
  const notExact = results.filter((r) => !r.score.exact);
  if (notExact.length > 0) {
    process.stderr.write(`\n${notExact.length} fixture(s) not scored exact:\n`);
    for (const r of notExact) process.stderr.write(`  ✗ ${r.fixture}\n`);
    return 1;
  }
  process.stdout.write("All fixtures exact; no regressions vs baseline.\n");
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`Fatal: ${(e as Error).stack ?? (e as Error).message}\n`);
      process.exit(1);
    });
}
