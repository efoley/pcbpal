/**
 * Seeded-defect review eval runner (stretch suite).
 *
 *   bun evals/review/run.ts                 # dry-run: synthesize review from golden (plumbing)
 *   bun evals/review/run.ts --live          # single Anthropic call over the review context
 *   bun evals/review/run.ts --accept-baseline
 *
 * Dry-run (default) is fully offline and does NOT test defect-finding quality —
 * it feeds the scorer a synthesized review that satisfies every criterion, so a
 * pass proves the plumbing (fixture load → context assembly → scoring → gate).
 * Live mode assembles a netlist+BOM review context and asks the model to find
 * the defect, then scores its answer. Live mode is implemented but UNTESTED here
 * (no API key in CI); it reuses the datasheet suite's AnthropicTransport.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BomDatabase } from "../../src/schemas/bom.js";
import { parseNetlistXml } from "../../src/services/netlist.js";
import {
  type Baseline,
  type CaseLine,
  diffBaseline,
  loadBaseline,
  writeBaseline,
} from "../src/shared/gate.js";
import { AnthropicTransport } from "../src/transport.js";
import { ReviewGolden, type ReviewScore, scoreReview, synthesizeReview } from "./score.js";

const SUITE_DIR = import.meta.dir;
const FIXTURES_DIR = join(SUITE_DIR, "fixtures");
const BASELINE_PATH = join(SUITE_DIR, "baseline.json");

const GATE = { headlineDropEps: 0.05, mustStayTrue: ["all_found"] };

const SYSTEM =
  "You are a meticulous hardware design reviewer. Given a schematic netlist and BOM, " +
  "identify design defects — missing decoupling/bypass caps, wrong feedback dividers, " +
  "floating enables — and explain each concisely, naming the affected references.";

/** Assemble the review context text the model (live) or a human would read. */
export function buildContext(netlistXml: string, bom: BomDatabase): string {
  const nl = parseNetlistXml(netlistXml);
  const comps = nl.components
    .map((c) => `  ${c.ref}: ${c.value} [${c.libPart}] fp=${c.footprint} — ${c.description}`)
    .join("\n");
  const nets = nl.nets
    .map((n) => `  ${n.name}: ${n.nodes.map((x) => `${x.ref}.${x.pin}`).join(", ")}`)
    .join("\n");
  const bomLines = bom.entries
    .map((e) => `  ${e.kicad_refs.join(",")}: ${e.role} (${e.category}, ${e.status})`)
    .join("\n");
  return `## Components\n${comps}\n\n## Nets\n${nets}\n\n## BOM\n${bomLines}\n`;
}

async function getReviewText(
  golden: ReviewGolden,
  context: string,
  live: boolean,
): Promise<string> {
  if (!live) return synthesizeReview(golden);
  const transport = new AnthropicTransport();
  const res = await transport.complete({
    system: SYSTEM,
    model: process.env.PCBPAL_EVAL_MODEL ?? "claude-opus-4-8",
    maxTokens: 1500,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Review this ${golden.target} for design defects. List each defect with the affected reference designators.\n\n${context}`,
          },
        ],
      },
    ],
  });
  return res.text;
}

export interface FixtureResult {
  fixture: string;
  score: ReviewScore;
  reviewText: string;
}

export async function runFixture(fixtureDir: string, live: boolean): Promise<FixtureResult> {
  const golden = ReviewGolden.parse(
    JSON.parse(await readFile(join(fixtureDir, "golden.json"), "utf-8")),
  );
  const bom = BomDatabase.parse(JSON.parse(await readFile(join(fixtureDir, "bom.json"), "utf-8")));
  const netlistXml = await readFile(join(fixtureDir, "netlist.xml"), "utf-8");
  const context = buildContext(netlistXml, bom);
  const reviewText = await getReviewText(golden, context, live);
  const score = scoreReview(golden, reviewText);
  return { fixture: golden.id, score, reviewText };
}

function caseLine(r: FixtureResult): CaseLine {
  return {
    key: `review:${r.fixture}`,
    headline: r.score.headline,
    metrics: { all_found: r.score.allFound, recall: r.score.headline },
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const live = argv.includes("--live");
  const acceptBaseline = argv.includes("--accept-baseline");

  const names = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  process.stderr.write(
    `Running ${names.length} review fixture(s) | mode=${live ? "live" : "dry-run"}\n`,
  );

  const results: FixtureResult[] = [];
  for (const name of names) {
    process.stderr.write(`• ${name} … `);
    const r = await runFixture(join(FIXTURES_DIR, name), live);
    results.push(r);
    process.stderr.write(
      `recall=${pct(r.score.headline)} found=[${r.score.found.join(",")}] missed=[${r.score.missed.join(",")}]\n`,
    );
  }

  const header = "| fixture | recall | all found | missed |\n|---|---:|:--:|---|";
  const rows = results.map(
    (r) =>
      `| ${r.fixture} | ${pct(r.score.headline)} | ${r.score.allFound ? "yes" : "NO"} | ${r.score.missed.join(",") || "-"} |`,
  );
  process.stdout.write(`${[header, ...rows].join("\n")}\n\n`);

  const cases = results.map(caseLine);
  const baseline: Baseline = await loadBaseline(BASELINE_PATH);
  const diff = diffBaseline(cases, baseline, GATE);

  if (acceptBaseline) {
    await writeBaseline(BASELINE_PATH, { ...baseline, ...diff.current });
    process.stdout.write(`Baseline updated: ${cases.length} case(s).\n`);
    return 0;
  }

  if (diff.newCases.length > 0) {
    process.stderr.write(
      `\n${diff.newCases.length} new case(s) with no baseline: ${diff.newCases.join(", ")}\n`,
    );
  }
  if (diff.regressions.length > 0) {
    process.stderr.write(`\n${diff.regressions.length} regression(s) vs baseline:\n`);
    for (const r of diff.regressions)
      process.stderr.write(`  ✗ ${r.key}: ${r.reasons.join("; ")}\n`);
    return 1;
  }
  process.stdout.write("No regressions vs baseline.\n");
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
