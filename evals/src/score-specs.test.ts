import { describe, expect, test } from "bun:test";
import type { SpecItem, SpecTable } from "../../src/schemas/datasheet.js";
import { type SpecScoreDetail, scoreSpecs } from "./score-specs.js";

function item(
  parameter: string,
  symbol: string | undefined,
  value: SpecItem["value"],
  page = 4,
  confidence: SpecItem["confidence"] = "high",
): SpecItem {
  return {
    parameter,
    ...(symbol ? { symbol } : {}),
    value,
    provenance: { page, label: "Electrical Characteristics" },
    confidence,
  };
}

function table(items: SpecItem[]): SpecTable {
  return { device: "X", section: "electrical_characteristics", items, not_found: [] };
}

const golden = table([
  item("Output Voltage", "VO", { typ: 3.3, unit: "V" }),
  item("Quiescent Current", "IQ", { typ: 5, max: 10, unit: "mA" }, 4, "medium"),
  item("Dropout Voltage", "VDROP", { typ: 1.1, unit: "V" }),
]);

function detailOf(score: ReturnType<typeof scoreSpecs>): SpecScoreDetail {
  return score.detail as unknown as SpecScoreDetail;
}

describe("scoreSpecs", () => {
  test("identical extraction is perfect", () => {
    const s = scoreSpecs(golden, golden);
    expect(s.headline).toBe(1);
    expect(s.hallucination_rate).toBe(0);
    const d = detailOf(s);
    expect(d.recall).toBe(1);
    expect(d.precision).toBe(1);
    expect(d.provenance_accuracy).toBe(1);
    expect(d.calibration.high.n).toBe(2);
    expect(d.calibration.high.correct).toBe(2);
  });

  test("omission lowers recall and headline", () => {
    const cand = table([golden.items[0]]); // only VO
    const s = scoreSpecs(golden, cand);
    const d = detailOf(s);
    expect(d.recall).toBeCloseTo(1 / 3);
    expect(d.omission_rate).toBeCloseTo(2 / 3);
    expect(s.headline).toBeLessThan(1);
    // 2 omissions, 0 hallucinations → weighted_error = 2/(5*3)
    expect(s.headline).toBeCloseTo(1 - 2 / 15);
  });

  test("wrong value counts as hallucination (weighted 4x)", () => {
    const cand = table([
      item("Output Voltage", "VO", { typ: 5.0, unit: "V" }), // wrong
      golden.items[1],
      golden.items[2],
    ]);
    const s = scoreSpecs(golden, cand);
    const d = detailOf(s);
    expect(d.value_wrong).toBe(1);
    expect(s.hallucination_rate).toBeCloseTo(1 / 3);
    // 1 hallucination, 0 omissions → weighted_error = 4/(5*3)
    expect(s.headline).toBeCloseTo(1 - 4 / 15);
    // A wrong high-confidence item breaks calibration.
    expect(d.calibration.high.correct).toBe(1);
  });

  test("invented item lowers precision and is a hallucination", () => {
    const cand = table([...golden.items, item("Fake Parameter", "ZZ", { typ: 99, unit: "V" })]);
    const s = scoreSpecs(golden, cand);
    const d = detailOf(s);
    expect(d.invented).toBe(1);
    expect(d.precision).toBeCloseTo(3 / 4);
    expect(s.hallucination_rate).toBeCloseTo(1 / 4);
  });

  test("wrong provenance page counts against provenance_accuracy", () => {
    const moved = item("Output Voltage", "VO", { typ: 3.3, unit: "V" }, 99);
    const cand = table([moved, golden.items[1], golden.items[2]]);
    const s = scoreSpecs(golden, cand);
    const d = detailOf(s);
    expect(d.provenance_wrong).toBe(1);
    expect(d.provenance_accuracy).toBeCloseTo(2 / 3);
    // provenance mismatch is a hallucination too
    expect(s.hallucination_rate).toBeCloseTo(1 / 3);
  });

  test("fuzzy parameter fallback matches when symbol absent", () => {
    const g = table([item("Input voltage", undefined, { typ: 5, unit: "V" })]);
    const c = table([item("Input voltage range", undefined, { typ: 5, unit: "V" })]);
    const s = scoreSpecs(g, c);
    expect(detailOf(s).matched).toBe(1);
    expect(s.headline).toBe(1);
  });
});
