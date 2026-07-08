/**
 * Search-relevance eval runner.
 *
 *   bun evals/search/run.ts                    # replay recordings, gate vs baseline
 *   bun evals/search/run.ts --live             # hit LCSC, RECORD, then score
 *   bun evals/search/run.ts --accept-baseline
 *
 * Default (replay) is fully offline: it scores committed recordings and skips a
 * query that has none. Live mode hits the shipped `searchComponents` client and
 * records the top hits before scoring. NOTE: LCSC is blocked in CI (403), so the
 * default replay path is what runs there; live mode is implemented, not CI-run.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Baseline,
  type CaseLine,
  diffBaseline,
  loadBaseline,
  writeBaseline,
} from "../src/shared/gate.js";
import { type GoldenQuery, SearchManifest, type SearchScore, scoreSearch } from "./score.js";
import { LiveRecordingTransport, ReplayTransport, type SearchTransport } from "./transport.js";

const SUITE_DIR = import.meta.dir;
const MANIFEST_PATH = join(SUITE_DIR, "manifest.json");
const RECORDINGS_DIR = join(SUITE_DIR, "recordings");
const BASELINE_PATH = join(SUITE_DIR, "baseline.json");

const GATE = {
  headlineDropEps: 0.05,
  increaseBad: [{ metric: "forbidden_hit", eps: 0 }],
};

interface QueryResult {
  query: GoldenQuery;
  score: SearchScore | null;
  skip?: string;
  synthetic: boolean;
}

async function runQuery(q: GoldenQuery, transport: SearchTransport): Promise<QueryResult> {
  const res = await transport.fetch(q.id, q.query);
  if ("skip" in res) return { query: q, score: null, skip: res.skip, synthetic: false };
  return { query: q, score: scoreSearch(q, res.hits), synthetic: res.synthetic };
}

function caseLine(r: QueryResult): CaseLine | null {
  if (!r.score) return null;
  return {
    key: `search:${r.query.id}`,
    headline: r.score.headline,
    metrics: {
      hit1: r.score.hit1,
      hit5: r.score.hit5,
      mrr: r.score.mrr,
      predicate_pass_rate: r.score.predicatePassRate,
      forbidden_hit: r.score.forbiddenHit ? 1 : 0,
    },
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function renderTable(results: QueryResult[]): string {
  const header =
    "| query | hit@1 | hit@5 | MRR | pred | forbid | headline | note |\n|---|:--:|:--:|---:|---:|:--:|---:|---|";
  const rows = results.map((r) => {
    if (!r.score) return `| ${r.query.id} | — | — | — | — | — | — | ${r.skip ?? "skipped"} |`;
    const s = r.score;
    return `| ${r.query.id} | ${s.hit1 ? "Y" : "n"} | ${s.hit5 ? "Y" : "n"} | ${s.mrr.toFixed(2)} | ${pct(s.predicatePassRate)} | ${s.forbiddenHit ? "HIT" : "-"} | ${pct(s.headline)} | ${r.synthetic ? "synthetic" : ""} |`;
  });
  return [header, ...rows].join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const live = argv.includes("--live");
  const acceptBaseline = argv.includes("--accept-baseline");
  const json = argv.includes("--json");

  const manifest = SearchManifest.parse(JSON.parse(await readFile(MANIFEST_PATH, "utf-8")));
  const transport: SearchTransport = live
    ? new LiveRecordingTransport(RECORDINGS_DIR)
    : new ReplayTransport(RECORDINGS_DIR);

  process.stderr.write(
    `Running ${manifest.queries.length} query(ies) | mode=${live ? "live+record" : "replay"}\n`,
  );

  const results: QueryResult[] = [];
  for (const q of manifest.queries) {
    process.stderr.write(`• ${q.id} … `);
    try {
      const r = await runQuery(q, transport);
      results.push(r);
      process.stderr.write(
        r.score ? `headline=${r.score.headline.toFixed(3)}\n` : `skipped (${r.skip})\n`,
      );
    } catch (e) {
      process.stderr.write(`ERROR ${(e as Error).message}\n`);
      results.push({
        query: q,
        score: null,
        skip: `error: ${(e as Error).message}`,
        synthetic: false,
      });
    }
  }

  const cases = results.map(caseLine).filter((c): c is CaseLine => c !== null);
  const baseline: Baseline = await loadBaseline(BASELINE_PATH);
  const diff = diffBaseline(cases, baseline, GATE);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ results: results.map((r) => ({ id: r.query.id, score: r.score, skip: r.skip })), regressions: diff.regressions }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${renderTable(results)}\n\n`);
    const scored = cases.length;
    const mean = scored === 0 ? 0 : cases.reduce((s, c) => s + c.headline, 0) / scored;
    process.stdout.write(
      `Scored ${scored}/${results.length} queries, mean headline ${pct(mean)}.\n`,
    );
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
