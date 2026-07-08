import { describe, expect, test } from "bun:test";
import {
  inferExpectedClass,
  normalizeUnit,
  parseQuantity,
  type UnitClass,
  unitClassOf,
} from "./units.js";

describe("normalizeUnit", () => {
  const cases: [string, string][] = [
    ["V", "V"],
    ["mV", "mV"],
    ["mA", "mA"],
    ["uF", "µF"],
    ["µF", "µF"],
    ["μF", "µF"], // greek mu
    ["uH", "µH"],
    ["nF", "nF"],
    ["pF", "pF"],
    ["kHz", "kHz"],
    ["MHz", "MHz"],
    ["GHz", "GHz"],
    ["Hz", "Hz"],
    ["ohm", "Ω"],
    ["Ohm", "Ω"],
    ["ohms", "Ω"],
    ["Ω", "Ω"],
    ["R", "Ω"],
    ["kohm", "kΩ"],
    ["kΩ", "kΩ"],
    ["MΩ", "MΩ"],
    ["C", "°C"],
    ["deg C", "°C"],
    ["degC", "°C"],
    ["℃", "°C"],
    ["°C", "°C"],
    ["%", "%"],
    ["dB", "dB"],
    ["ppm", "ppm"],
    ["ms", "ms"],
    ["µs", "µs"],
    ["ns", "ns"],
    ["s", "s"],
    ["  mV  ", "mV"], // trims
    ["bits", "bit"],
    ["bytes", "byte"],
    ["Msps", "Msps"], // unknown → unchanged
    ["", ""],
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" → "${expected}"`, () => {
      expect(normalizeUnit(input)).toBe(expected);
    });
  }
});

describe("parseQuantity", () => {
  const cases: [string, number, string][] = [
    ["10µF", 1e-5, "F"],
    ["10uF", 1e-5, "F"],
    ["2.2 uH", 2.2e-6, "H"],
    ["100kΩ", 1e5, "Ω"],
    ["100kohm", 1e5, "Ω"],
    ["0.5%", 0.5, "%"],
    ["-40°C", -40, "°C"],
    ["-40 degC", -40, "°C"],
    ["3.3V", 3.3, "V"],
    ["500mA", 0.5, "A"],
    ["1A", 1, "A"],
    ["16MHz", 16e6, "Hz"],
    ["100 ppm", 100, "ppm"],
    [".5V", 0.5, "V"],
    ["1e3Hz", 1000, "Hz"],
  ];
  for (const [input, value, unit] of cases) {
    test(`"${input}" → ${value} ${unit}`, () => {
      const q = parseQuantity(input);
      expect(q).not.toBeNull();
      expect(q?.value).toBeCloseTo(value, 12);
      expect(q?.unit).toBe(unit);
    });
  }

  test("returns null for a bare number", () => {
    expect(parseQuantity("42")).toBeNull();
  });

  test("returns null for empty / non-numeric", () => {
    expect(parseQuantity("")).toBeNull();
    expect(parseQuantity("abc")).toBeNull();
  });

  test("unknown unit keeps value and normalized unit", () => {
    const q = parseQuantity("5 widgets");
    expect(q).toEqual({ value: 5, unit: "widgets" });
  });
});

describe("unitClassOf", () => {
  const cases: [string, UnitClass][] = [
    ["V", "voltage"],
    ["mV", "voltage"],
    ["A", "current"],
    ["mA", "current"],
    ["W", "power"],
    ["mW", "power"],
    ["Hz", "frequency"],
    ["MHz", "frequency"],
    ["F", "capacitance"],
    ["µF", "capacitance"],
    ["H", "inductance"],
    ["µH", "inductance"],
    ["Ω", "resistance"],
    ["kΩ", "resistance"],
    ["°C", "temperature"],
    ["s", "time"],
    ["ms", "time"],
    ["%", "percent"],
    ["dB", "other"],
    ["ppm", "other"],
    ["bit", "other"],
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" → ${expected}`, () => {
      expect(unitClassOf(input)).toBe(expected);
    });
  }
});

describe("inferExpectedClass", () => {
  test("parameter keywords", () => {
    expect(inferExpectedClass("Input voltage")).toBe("voltage");
    expect(inferExpectedClass("Quiescent current")).toBe("current");
    expect(inferExpectedClass("On resistance")).toBe("resistance");
    expect(inferExpectedClass("Output capacitance")).toBe("capacitance");
    expect(inferExpectedClass("Inductance")).toBe("inductance");
    expect(inferExpectedClass("Switching frequency")).toBe("frequency");
    expect(inferExpectedClass("Junction temperature")).toBe("temperature");
    expect(inferExpectedClass("Power dissipation")).toBe("power");
    expect(inferExpectedClass("Rise time")).toBe("time");
    expect(inferExpectedClass("Propagation delay")).toBe("time");
  });

  test("V_ pattern → voltage", () => {
    expect(inferExpectedClass("V_IN range")).toBe("voltage");
  });

  test("ambiguous parameter → null", () => {
    expect(inferExpectedClass("Power supply voltage")).toBeNull();
  });

  test("no keyword, no symbol → null", () => {
    expect(inferExpectedClass("Some attribute")).toBeNull();
  });

  test("falls back to symbol leading letter", () => {
    expect(inferExpectedClass("foo", "VIN")).toBe("voltage");
    expect(inferExpectedClass("foo", "IQ")).toBe("current");
    expect(inferExpectedClass("foo", "TJ")).toBe("temperature");
    expect(inferExpectedClass("foo", "TA")).toBe("temperature");
    expect(inferExpectedClass("foo", "fSW")).toBe("frequency");
    expect(inferExpectedClass("foo", "RDS")).toBe("resistance");
    expect(inferExpectedClass("foo", "COUT")).toBe("capacitance");
    expect(inferExpectedClass("foo", "L")).toBe("inductance");
    expect(inferExpectedClass("foo", "PD")).toBe("power");
    expect(inferExpectedClass("foo", "tD")).toBe("time");
  });

  test("symbol case matters (f vs F, t vs T)", () => {
    expect(inferExpectedClass("foo", "F")).toBeNull(); // capital F (farads) is not a mapped symbol
    expect(inferExpectedClass("foo", "TA")).toBe("temperature"); // capital T not time
  });

  test("unrecognized symbol → null", () => {
    expect(inferExpectedClass("foo", "GND")).toBeNull();
  });

  test("parameter keyword wins over symbol", () => {
    expect(inferExpectedClass("Input voltage", "IQ")).toBe("voltage");
  });
});
