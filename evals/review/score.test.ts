import { describe, expect, test } from "bun:test";
import { type ReviewGolden, scoreReview, synthesizeReview } from "./score.js";

const golden: ReviewGolden = {
  id: "t",
  defect: "U1 missing decoupling cap",
  target: "schematic",
  mustMention: [
    { id: "role", regex: "(?i)decoupl|bypass", why: "role", sample: "decoupling cap" },
    { id: "value", regex: "(?i)100\\s*nf", why: "value", sample: "100nF" },
    { id: "ref", regex: "\\bU1\\b", why: "ref", sample: "U1" },
  ],
};

describe("scoreReview", () => {
  test("a review mentioning all criteria scores recall 1 and allFound", () => {
    const text = "U1 is missing a 100nF decoupling capacitor on VIN.";
    const s = scoreReview(golden, text);
    expect(s.headline).toBe(1);
    expect(s.allFound).toBe(true);
    expect(s.missed).toEqual([]);
  });

  test("a review missing a criterion reports it and lowers recall", () => {
    const text = "U1 is missing a bypass capacitor."; // no explicit 100nF value
    const s = scoreReview(golden, text);
    expect(s.allFound).toBe(false);
    expect(s.missed).toEqual(["value"]);
    expect(s.headline).toBeCloseTo(2 / 3);
  });

  test("an off-target review finds nothing", () => {
    const s = scoreReview(golden, "The layout looks fine.");
    expect(s.headline).toBe(0);
    expect(s.found).toEqual([]);
  });

  test("synthesizeReview satisfies every criterion (dry-run plumbing)", () => {
    const s = scoreReview(golden, synthesizeReview(golden));
    expect(s.allFound).toBe(true);
  });
});
