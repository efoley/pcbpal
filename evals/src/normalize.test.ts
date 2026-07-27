import { describe, expect, test } from "bun:test";
import type { SpecValue } from "../../src/schemas/datasheet.js";
import { foldName, fuzzyNameMatch, normalizeName, specKey, specValuesAgree } from "./normalize.js";

describe("name normalization", () => {
  test("normalizeName lowercases and collapses", () => {
    expect(normalizeName("  Input  Voltage (VIN) ")).toBe("input voltage vin");
  });
  test("foldName strips non-alphanumerics", () => {
    expect(foldName("V_OUT (max)")).toBe("voutmax");
  });
  test("specKey prefers symbol over parameter", () => {
    expect(specKey({ parameter: "Output Voltage", symbol: "VO" })).toBe("symbol:vo");
    expect(specKey({ parameter: "Output Voltage" })).toBe("param:outputvoltage");
    expect(specKey({ parameter: "X", symbol: "  " })).toBe("param:x");
  });
});

describe("fuzzyNameMatch", () => {
  test("exact fold matches", () => {
    expect(fuzzyNameMatch("Input Voltage", "input  voltage")).toBe(true);
  });
  test("substring matches (range suffix)", () => {
    expect(fuzzyNameMatch("Input voltage", "Input voltage range")).toBe(true);
  });
  test("unrelated names do not match", () => {
    expect(fuzzyNameMatch("Quiescent Current", "Output Voltage")).toBe(false);
  });
  test("empty never matches", () => {
    expect(fuzzyNameMatch("", "x")).toBe(false);
  });
});

describe("specValuesAgree", () => {
  const v = (o: Partial<SpecValue>): SpecValue => ({ unit: "V", ...o });

  test("identical values agree", () => {
    expect(specValuesAgree(v({ typ: 3.3 }), v({ typ: 3.3 }))).toBe(true);
  });
  test("within 2% tolerance agrees", () => {
    expect(specValuesAgree(v({ typ: 3.3 }), v({ typ: 3.32 }))).toBe(true);
  });
  test("beyond 2% disagrees", () => {
    expect(specValuesAgree(v({ typ: 3.3 }), v({ typ: 3.5 }))).toBe(false);
  });
  test("prefix-equivalent units agree (800mA == 0.8A)", () => {
    expect(specValuesAgree({ typ: 800, unit: "mA" }, { typ: 0.8, unit: "A" })).toBe(true);
  });
  test("different unit class disagrees (V vs A)", () => {
    expect(specValuesAgree({ typ: 1, unit: "V" }, { typ: 1, unit: "A" })).toBe(false);
  });
  test("fabricated max (presence mismatch) disagrees", () => {
    expect(specValuesAgree(v({ typ: 1.1 }), v({ typ: 1.1, max: 1.3 }))).toBe(false);
  });
  test("missing typ where golden has one disagrees", () => {
    expect(specValuesAgree(v({ typ: 1.1 }), v({ min: 1.1 }))).toBe(false);
  });
  test("multi-field within tolerance agrees", () => {
    expect(
      specValuesAgree(
        v({ min: 3.267, typ: 3.3, max: 3.333 }),
        v({ min: 3.27, typ: 3.3, max: 3.33 }),
      ),
    ).toBe(true);
  });
});
