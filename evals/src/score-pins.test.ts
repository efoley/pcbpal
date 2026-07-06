import { describe, expect, test } from "bun:test";
import type { PinEntry, PinTable } from "../../src/schemas/datasheet.js";
import { type PinScoreDetail, scorePins } from "./score-pins.js";

function pin(number: string, name: string, type: PinEntry["type"]): PinEntry {
  return { number, name, type, provenance: { page: 1, label: "Pin Configuration" } };
}

function table(pins: PinEntry[]): PinTable {
  return { device: "X", package: "SOT-23-5", pin_count: pins.length, pins };
}

const golden = table([
  pin("1", "VOUT", "power_out"),
  pin("2", "GND", "passive"),
  pin("3", "EN", "input"),
  pin("4", "FB", "input"),
  pin("5", "VIN", "power_in"),
]);

const detailOf = (s: ReturnType<typeof scorePins>): PinScoreDetail =>
  s.detail as unknown as PinScoreDetail;

describe("scorePins", () => {
  test("identical is perfect", () => {
    const s = scorePins(golden, golden);
    expect(s.headline).toBe(1);
    expect(s.hallucination_rate).toBe(0);
    const d = detailOf(s);
    expect(d.coverage).toBe(1);
    expect(d.name_accuracy).toBe(1);
    expect(d.type_accuracy).toBe(1);
  });

  test("case-insensitive name match", () => {
    const cand = table([
      pin("1", "vout", "power_out"),
      pin("2", "gnd", "passive"),
      pin("3", "en", "input"),
      pin("4", "fb", "input"),
      pin("5", "vin", "power_in"),
    ]);
    expect(scorePins(golden, cand).headline).toBe(1);
  });

  test("wrong type lowers type_accuracy and exact", () => {
    const cand = table([
      pin("1", "VOUT", "output"), // wrong type
      pin("2", "GND", "passive"),
      pin("3", "EN", "input"),
      pin("4", "FB", "input"),
      pin("5", "VIN", "power_in"),
    ]);
    const s = scorePins(golden, cand);
    const d = detailOf(s);
    expect(d.type_accuracy).toBeCloseTo(4 / 5);
    expect(d.exact).toBe(4);
    expect(s.headline).toBeCloseTo(4 / 5);
  });

  test("missing pin lowers coverage", () => {
    const cand = table([
      pin("1", "VOUT", "power_out"),
      pin("2", "GND", "passive"),
      pin("3", "EN", "input"),
      pin("4", "FB", "input"),
    ]);
    const s = scorePins(golden, cand);
    const d = detailOf(s);
    expect(d.coverage).toBeCloseTo(4 / 5);
    expect(d.missing_pins).toEqual(["5"]);
  });

  test("extra pin is a hallucination", () => {
    const cand = table([...golden.pins, pin("6", "NC", "nc")]);
    const s = scorePins(golden, cand);
    const d = detailOf(s);
    expect(d.extra_pins).toEqual(["6"]);
    expect(s.hallucination_rate).toBeCloseTo(1 / 6);
  });
});
