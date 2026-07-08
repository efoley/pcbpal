/**
 * Generic baseline + regression gate shared by the sibling eval suites
 * (bom-sync, search, review).
 *
 * It mirrors the conventions of the datasheet suite's `report.ts` — a committed
 * baseline turns "did my change help?" into a CI-able answer — but is
 * facet-agnostic: each suite hands it per-case `{ key, headline, metrics }` and
 * a small rule set describing what counts as a regression. The datasheet suite
 * keeps its own bespoke `report.ts` untouched; this module is additive.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

export type MetricValue = number | boolean | null;

export interface BaselineEntry {
  headline: number;
  metrics: Record<string, MetricValue>;
}

export type Baseline = Record<string, BaselineEntry>;

export interface CaseLine {
  key: string;
  headline: number; // [0,1], higher is better
  metrics: Record<string, MetricValue>;
}

export interface GateConfig {
  /** Regression if headline drops by more than this vs baseline. Default 0.05. */
  headlineDropEps?: number;
  /** Numeric metrics where an INCREASE beyond eps is a regression (e.g. error rates). */
  increaseBad?: { metric: string; eps: number }[];
  /** Boolean metrics that must not flip true → false. */
  mustStayTrue?: string[];
}

export interface Regression {
  key: string;
  reasons: string[];
}

export interface BaselineDiff {
  regressions: Regression[];
  improvements: string[];
  newCases: string[];
  /** Baseline entries derived from this run, for --accept-baseline. */
  current: Baseline;
}

const DEFAULT_HEADLINE_DROP = 0.05;

export function diffBaseline(cases: CaseLine[], baseline: Baseline, cfg: GateConfig): BaselineDiff {
  const headlineDropEps = cfg.headlineDropEps ?? DEFAULT_HEADLINE_DROP;
  const regressions: Regression[] = [];
  const improvements: string[] = [];
  const newCases: string[] = [];
  const current: Baseline = {};

  for (const c of cases) {
    current[c.key] = { headline: c.headline, metrics: c.metrics };
    const base = baseline[c.key];
    if (!base) {
      newCases.push(c.key);
      continue;
    }

    const reasons: string[] = [];
    if (base.headline - c.headline > headlineDropEps) {
      reasons.push(`headline ${base.headline.toFixed(3)} → ${c.headline.toFixed(3)}`);
    }
    for (const { metric, eps } of cfg.increaseBad ?? []) {
      const cur = c.metrics[metric];
      const prev = base.metrics[metric];
      if (typeof cur === "number" && typeof prev === "number" && cur - prev > eps) {
        reasons.push(`${metric} ${prev.toFixed(3)} → ${cur.toFixed(3)}`);
      }
    }
    for (const metric of cfg.mustStayTrue ?? []) {
      if (base.metrics[metric] === true && c.metrics[metric] === false) {
        reasons.push(`${metric} true → false`);
      }
    }

    if (reasons.length > 0) regressions.push({ key: c.key, reasons });
    else if (c.headline - base.headline > headlineDropEps) improvements.push(c.key);
  }

  return { regressions, improvements, newCases, current };
}

export async function loadBaseline(path: string): Promise<Baseline> {
  if (!existsSync(path)) return {};
  return JSON.parse(await readFile(path, "utf-8")) as Baseline;
}

export async function writeBaseline(path: string, baseline: Baseline): Promise<void> {
  const sorted: Baseline = {};
  for (const key of Object.keys(baseline).sort()) sorted[key] = baseline[key];
  await writeFile(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

// ── Small set helpers reused by the suite scorers ──

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
