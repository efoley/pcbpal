import { describe, expect, test } from "bun:test";
import { diffBaseline } from "./report.js";
import type { Baseline, CaseResult, CaseScore, EvalRun } from "./types.js";

function score(headline: number, hallucination: number, topo: boolean | null): CaseScore {
  return { headline, hallucination_rate: hallucination, topologyPass: topo, detail: {} };
}

function result(
  partId: string,
  score: CaseScore | null,
  opts: Partial<CaseResult> = {},
): CaseResult {
  return {
    partId,
    mpn: partId.toUpperCase(),
    facet: "specs",
    strategy: "single-pass",
    model: "m",
    skipped: score === null,
    unverifiedGolden: false,
    calls: 1,
    score,
    ...opts,
  };
}

function run(cases: CaseResult[]): EvalRun {
  return {
    runLabel: "t",
    timestamp: "2026-07-06T00:00:00.000Z",
    model: "m",
    strategy: "single-pass",
    dryRun: true,
    cases,
  };
}

describe("diffBaseline", () => {
  test("no baseline entry → new case, no regression", () => {
    const d = diffBaseline(run([result("a", score(1, 0, null))]), {});
    expect(d.regressions).toEqual([]);
    expect(d.newCases.length).toBe(1);
    expect(Object.keys(d.current).length).toBe(1);
  });

  test("hallucination_rate rise beyond 0.01 is a regression", () => {
    const base: Baseline = {
      "a:specs:single-pass:m": { headline: 1, hallucination_rate: 0.0, topologyPass: null },
    };
    const d = diffBaseline(run([result("a", score(1, 0.05, null))]), base);
    expect(d.regressions.length).toBe(1);
    expect(d.regressions[0].reasons[0]).toMatch(/hallucination_rate/);
  });

  test("topologyPass true→false is a regression", () => {
    const key = "a:circuit:single-pass:m";
    const base: Baseline = { [key]: { headline: 1, hallucination_rate: 0, topologyPass: true } };
    const c = result("a", score(1, 0, false), { facet: "circuit" });
    const d = diffBaseline(run([c]), base);
    expect(d.regressions.length).toBe(1);
    expect(d.regressions[0].reasons.some((r) => r.includes("topologyPass"))).toBe(true);
  });

  test("headline drop beyond 0.05 is a regression", () => {
    const base: Baseline = {
      "a:specs:single-pass:m": { headline: 1, hallucination_rate: 0, topologyPass: null },
    };
    const d = diffBaseline(run([result("a", score(0.9, 0, null))]), base);
    expect(d.regressions.length).toBe(1);
  });

  test("small fluctuations within epsilon are not regressions", () => {
    const base: Baseline = {
      "a:specs:single-pass:m": { headline: 1, hallucination_rate: 0, topologyPass: null },
    };
    const d = diffBaseline(run([result("a", score(0.98, 0.005, null))]), base);
    expect(d.regressions).toEqual([]);
  });

  test("skipped cases contribute nothing", () => {
    const d = diffBaseline(run([result("a", null)]), {});
    expect(Object.keys(d.current).length).toBe(0);
    expect(d.newCases.length).toBe(0);
  });
});
