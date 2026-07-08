/**
 * Aggregation, markdown/JSON reporting, and baseline diffing.
 *
 * A committed baseline turns "did my prompt change help?" into a CI-able
 * answer: a run regresses (exit 1) when, versus baseline, any case's
 * hallucination_rate rises > 0.01, its circuit topologyPass flips true→false,
 * or its headline drops > 0.05.
 */

import {
  type Baseline,
  type BaselineEntry,
  type CaseResult,
  caseKey,
  type EvalRun,
} from "./types.js";

export const HALLUCINATION_EPS = 0.01;
export const HEADLINE_DROP_EPS = 0.05;

export interface Regression {
  key: string;
  reasons: string[];
}

export interface BaselineDiff {
  regressions: Regression[];
  improvements: string[];
  newCases: string[];
  current: Baseline; // baseline entries derived from this run (for --accept-baseline)
}

function keyOf(c: CaseResult): string {
  return caseKey(c.partId, c.facet, c.strategy, c.model, c.label);
}

function entryOf(c: CaseResult): BaselineEntry | null {
  if (!c.score) return null;
  return {
    headline: c.score.headline,
    hallucination_rate: c.score.hallucination_rate,
    topologyPass: c.score.topologyPass,
  };
}

export function diffBaseline(run: EvalRun, baseline: Baseline): BaselineDiff {
  const regressions: Regression[] = [];
  const improvements: string[] = [];
  const newCases: string[] = [];
  const current: Baseline = {};

  for (const c of run.cases) {
    if (c.skipped || !c.score) continue;
    const key = keyOf(c);
    const cur = entryOf(c);
    if (cur) current[key] = cur;

    const base = baseline[key];
    if (!base) {
      newCases.push(key);
      continue;
    }
    const reasons: string[] = [];
    if (c.score.hallucination_rate - base.hallucination_rate > HALLUCINATION_EPS) {
      reasons.push(
        `hallucination_rate ${base.hallucination_rate.toFixed(3)} → ${c.score.hallucination_rate.toFixed(3)}`,
      );
    }
    if (base.topologyPass === true && c.score.topologyPass === false) {
      reasons.push("topologyPass true → false");
    }
    if (base.headline - c.score.headline > HEADLINE_DROP_EPS) {
      reasons.push(`headline ${base.headline.toFixed(3)} → ${c.score.headline.toFixed(3)}`);
    }
    if (reasons.length > 0) regressions.push({ key, reasons });
    else if (c.score.headline - base.headline > HEADLINE_DROP_EPS) improvements.push(key);
  }

  return { regressions, improvements, newCases, current };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function topo(v: boolean | null): string {
  if (v === null) return "—";
  return v ? "pass" : "FAIL";
}

/** Compact one-line-per-case table for stdout / report.md. */
export function renderTable(run: EvalRun): string {
  const header =
    "| part | facet | strategy | headline | halluc | topo | calls | note |\n" +
    "|---|---|---|---:|---:|:--:|---:|---|";
  const rows = run.cases.map((c) => {
    const facet = c.label ? `${c.facet}:${c.label}` : c.facet;
    if (c.skipped || !c.score) {
      return `| ${c.partId} | ${facet} | ${c.strategy} | — | — | — | ${c.calls} | ${c.reason ?? "skipped"} |`;
    }
    return `| ${c.partId} | ${facet} | ${c.strategy} | ${pct(c.score.headline)} | ${pct(c.score.hallucination_rate)} | ${topo(c.score.topologyPass)} | ${c.calls} | ${c.unverifiedGolden ? "UNVERIFIED golden" : ""} |`;
  });
  return [header, ...rows].join("\n");
}

export function renderReport(run: EvalRun, diff: BaselineDiff): string {
  const scored = run.cases.filter((c) => !c.skipped && c.score);
  const skipped = run.cases.filter((c) => c.skipped || !c.score);
  const avgHeadline =
    scored.length === 0
      ? 0
      : scored.reduce((s, c) => s + (c.score?.headline ?? 0), 0) / scored.length;

  const lines: string[] = [];
  lines.push(`# Datasheet eval run — ${run.runLabel}`);
  lines.push("");
  lines.push(`- Timestamp: ${run.timestamp}`);
  lines.push(`- Model: \`${run.model}\`  Strategy: \`${run.strategy}\`  Dry-run: ${run.dryRun}`);
  lines.push(`- Cases scored: ${scored.length}  skipped: ${skipped.length}`);
  lines.push(`- Mean headline (scored): ${pct(avgHeadline)}`);
  if (run.cases.some((c) => c.unverifiedGolden)) {
    lines.push("");
    lines.push(
      "> ⚠️ One or more goldens are UNVERIFIED (draft, not human-checked). Scores against them are plumbing signal, not truth.",
    );
  }
  lines.push("");
  lines.push("## Cases");
  lines.push("");
  lines.push(renderTable(run));
  lines.push("");
  lines.push("## Baseline diff");
  lines.push("");
  if (diff.regressions.length === 0) {
    lines.push("No regressions vs baseline.");
  } else {
    lines.push(`**${diff.regressions.length} regression(s):**`);
    for (const r of diff.regressions) lines.push(`- \`${r.key}\`: ${r.reasons.join("; ")}`);
  }
  if (diff.newCases.length > 0) {
    lines.push("");
    lines.push(`New cases (no baseline yet): ${diff.newCases.length}`);
  }
  lines.push("");
  return lines.join("\n");
}
