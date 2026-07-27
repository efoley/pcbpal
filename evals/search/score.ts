/**
 * Scorer for the search-relevance suite.
 *
 * Each golden query carries acceptance criteria: an any-of set of acceptable
 * LCSC ids, attribute predicates the top result must satisfy (package equals,
 * description regex, in-stock, has-footprint), and a forbidden id set that must
 * not appear. Metrics per query (design-docs/...evals.md §8 "Search relevance"):
 *
 *  - hit@1 / hit@5 — an any-of id at rank 1 / within the top 5
 *  - MRR — reciprocal rank of the first any-of id (0 if none)
 *  - predicate pass rate — fraction of predicates the #1 hit satisfies
 *  - forbidden-hit — any forbidden id present in the results
 *
 * Headline blends hit@1/hit@5/MRR/predicate-pass, penalised hard on a forbidden
 * hit (surfacing a wrong-part is worse than a missing one).
 */

import { z } from "zod";
import type { RecordedHit } from "./transport.js";

export const QueryPredicates = z.object({
  packageEquals: z.string().optional(),
  descriptionRegex: z.string().optional(),
  mpnRegex: z.string().optional(),
  inStock: z.boolean().optional(),
  hasFootprint: z.boolean().optional(),
});
export type QueryPredicates = z.infer<typeof QueryPredicates>;

export const GoldenQuery = z.object({
  id: z.string(),
  query: z.string(),
  note: z.string().optional(),
  anyOf: z.array(z.string()).default([]),
  predicates: QueryPredicates.default({}),
  forbidden: z.array(z.string()).default([]),
});
export type GoldenQuery = z.infer<typeof GoldenQuery>;

export const SearchManifest = z.object({ queries: z.array(GoldenQuery) });
export type SearchManifest = z.infer<typeof SearchManifest>;

export interface SearchScore {
  headline: number;
  hit1: boolean;
  hit5: boolean;
  mrr: number;
  matchedRank: number | null; // 1-based rank of first any-of id
  predicatePassRate: number;
  predicatesTotal: number;
  predicatesPassed: number;
  forbiddenHit: boolean;
}

/**
 * Compile a golden regex. JS `RegExp` has no inline `(?i)` flag syntax, so a
 * leading inline-flag group (e.g. `(?i)`, `(?im)`) is translated to real flags —
 * keeping the manifest's patterns readable and PCRE-familiar.
 */
export function compileRegex(pattern: string): RegExp {
  const m = pattern.match(/^\(\?([a-z]+)\)(.*)$/s);
  if (m) return new RegExp(m[2], m[1]);
  return new RegExp(pattern);
}

/** Evaluate the top hit against a query's attribute predicates. */
function evalPredicates(
  hit: RecordedHit | undefined,
  p: QueryPredicates,
): { total: number; passed: number } {
  const checks: boolean[] = [];
  if (p.packageEquals !== undefined) {
    checks.push(!!hit && hit.package.toLowerCase() === p.packageEquals.toLowerCase());
  }
  if (p.descriptionRegex !== undefined) {
    const re = compileRegex(p.descriptionRegex);
    checks.push(!!hit && re.test(hit.description));
  }
  if (p.mpnRegex !== undefined) {
    const re = compileRegex(p.mpnRegex);
    checks.push(!!hit && re.test(hit.mpn));
  }
  if (p.inStock !== undefined) {
    checks.push(!!hit && hit.stock > 0 === p.inStock);
  }
  if (p.hasFootprint !== undefined) {
    checks.push(!!hit && hit.has_footprint === p.hasFootprint);
  }
  return { total: checks.length, passed: checks.filter(Boolean).length };
}

export function scoreSearch(golden: GoldenQuery, hits: RecordedHit[]): SearchScore {
  const anyOf = new Set(golden.anyOf);
  let matchedRank: number | null = null;
  for (let i = 0; i < hits.length; i++) {
    if (anyOf.has(hits[i].lcsc)) {
      matchedRank = i + 1;
      break;
    }
  }

  const hit1 = matchedRank === 1;
  const hit5 = matchedRank !== null && matchedRank <= 5;
  const mrr = matchedRank === null ? 0 : 1 / matchedRank;

  const forbidden = new Set(golden.forbidden);
  const forbiddenHit = hits.some((h) => forbidden.has(h.lcsc));

  const pred = evalPredicates(hits[0], golden.predicates);
  const predicatePassRate = pred.total === 0 ? 1 : pred.passed / pred.total;

  const base = (Number(hit1) + Number(hit5) + mrr + predicatePassRate) / 4;
  const headline = forbiddenHit ? Math.max(0, base - 0.5) : base;

  return {
    headline,
    hit1,
    hit5,
    mrr,
    matchedRank,
    predicatePassRate,
    predicatesTotal: pred.total,
    predicatesPassed: pred.passed,
    forbiddenHit,
  };
}
