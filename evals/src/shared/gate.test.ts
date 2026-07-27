import { describe, expect, test } from "bun:test";
import { type Baseline, diffBaseline, jaccard, setsEqual } from "./gate.js";

const baseline: Baseline = {
  a: { headline: 0.9, metrics: { exact: true, err: 0.1 } },
  b: { headline: 0.8, metrics: { exact: false, err: 0.2 } },
};

const GATE = {
  headlineDropEps: 0.05,
  increaseBad: [{ metric: "err", eps: 0.01 }],
  mustStayTrue: ["exact"],
};

describe("diffBaseline", () => {
  test("no regressions when metrics hold", () => {
    const d = diffBaseline(
      [{ key: "a", headline: 0.92, metrics: { exact: true, err: 0.1 } }],
      baseline,
      GATE,
    );
    expect(d.regressions).toHaveLength(0);
    expect(d.current.a.headline).toBe(0.92);
  });

  test("headline drop beyond eps regresses", () => {
    const d = diffBaseline(
      [{ key: "a", headline: 0.8, metrics: { exact: true, err: 0.1 } }],
      baseline,
      GATE,
    );
    expect(d.regressions).toHaveLength(1);
    expect(d.regressions[0].reasons[0]).toContain("headline");
  });

  test("error-metric increase and boolean flip both regress", () => {
    const d = diffBaseline(
      [{ key: "a", headline: 0.9, metrics: { exact: false, err: 0.5 } }],
      baseline,
      GATE,
    );
    expect(d.regressions).toHaveLength(1);
    expect(d.regressions[0].reasons).toHaveLength(2); // err up + exact true→false
  });

  test("unseen key is reported as new, not a regression", () => {
    const d = diffBaseline([{ key: "z", headline: 0.5, metrics: {} }], baseline, GATE);
    expect(d.newCases).toEqual(["z"]);
    expect(d.regressions).toHaveLength(0);
  });
});

describe("set helpers", () => {
  test("jaccard of two empty sets is 1", () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
  test("jaccard partial overlap", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
  });
  test("setsEqual", () => {
    expect(setsEqual(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
    expect(setsEqual(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
  });
});
