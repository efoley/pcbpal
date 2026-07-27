import { describe, expect, test } from "bun:test";
import type { PinTable, ReferenceCircuit, SpecTable } from "../schemas/datasheet.js";
import {
  crossCheckPackage,
  crossCheckSpecs,
  deriveNets,
  type Finding,
  fuzzyNameMatch,
  packagesMatch,
  relativeQuantityDiff,
  validatePinTable,
  validateSpecTable,
} from "./refcircuit.js";

const prov = { page: 1, label: "Figure 1" };

function codes(findings: Finding[]): string[] {
  return findings.map((f) => f.code);
}

// ── A clean buck-converter reference circuit ──
// U1 (IC): 1=VIN, 2=GND, 3=SW, 4=FB, 5=EN
// L1: A=SW→VOUT, B=VOUT
// C1: input cap VIN↔GND ; C2: output cap VOUT↔GND
// R1/R2: feedback divider VOUT→FB→GND
function cleanBuck(): ReferenceCircuit {
  return {
    device: "MP2315",
    title: "Typical Application",
    provenance: prov,
    rails: ["VIN", "VOUT", "GND", "SW", "FB"],
    notes: [],
    confidence: "high",
    components: [
      {
        designator: "U1",
        kind: "ic",
        pins: [
          { pin: "1", connects_to: ["VIN", "C1.1"] },
          { pin: "2", connects_to: ["GND", "C1.2"] },
          { pin: "3", connects_to: ["SW", "L1.A"] },
          { pin: "4", connects_to: ["FB", "R1.2", "R2.1"] },
          { pin: "5", connects_to: ["VIN"] },
        ],
      },
      {
        designator: "L1",
        kind: "inductor",
        value: "2.2µH",
        pins: [
          { pin: "A", connects_to: ["SW", "U1.3"] },
          { pin: "B", connects_to: ["VOUT"] },
        ],
      },
      {
        designator: "C1",
        kind: "capacitor",
        value: "10µF",
        pins: [
          { pin: "1", connects_to: ["VIN", "U1.1"] },
          { pin: "2", connects_to: ["GND", "U1.2"] },
        ],
      },
      {
        designator: "C2",
        kind: "capacitor",
        value: "22µF",
        pins: [
          { pin: "1", connects_to: ["VOUT"] },
          { pin: "2", connects_to: ["GND"] },
        ],
      },
      {
        designator: "R1",
        kind: "resistor",
        value: "100kΩ",
        pins: [
          { pin: "1", connects_to: ["VOUT"] },
          { pin: "2", connects_to: ["FB", "U1.4", "R2.1"] },
        ],
      },
      {
        designator: "R2",
        kind: "resistor",
        value: "10kΩ",
        pins: [
          { pin: "1", connects_to: ["FB", "U1.4", "R1.2"] },
          { pin: "2", connects_to: ["GND"] },
        ],
      },
    ],
  };
}

describe("deriveNets — clean buck converter", () => {
  test("produces zero findings", () => {
    const { findings } = deriveNets(cleanBuck());
    expect(findings).toEqual([]);
  });

  test("derives named rails as nets", () => {
    const { nets } = deriveNets(cleanBuck());
    const names = nets.map((n) => n.name).sort();
    expect(names).toEqual(["FB", "GND", "SW", "VIN", "VOUT"]);
  });

  test("VIN net has the right members", () => {
    const { nets } = deriveNets(cleanBuck());
    const vin = nets.find((n) => n.name === "VIN");
    expect(vin?.members).toEqual(["C1.1", "U1.1", "U1.5"]);
  });

  test("FB net merges the divider tap", () => {
    const { nets } = deriveNets(cleanBuck());
    const fb = nets.find((n) => n.name === "FB");
    expect(fb?.members.sort()).toEqual(["R1.2", "R2.1", "U1.4"]);
  });
});

describe("deriveNets — findings", () => {
  test("undeclared_component", () => {
    const c = cleanBuck();
    c.components[0].pins[2].connects_to = ["SW", "Q9.G"]; // Q9 not declared
    const { findings } = deriveNets(c);
    expect(codes(findings)).toContain("undeclared_component");
  });

  test("unknown_pin", () => {
    const c = cleanBuck();
    c.components[0].pins[0].connects_to = ["VIN", "C1.9"]; // C1 has no pin 9
    const { findings } = deriveNets(c);
    expect(codes(findings)).toContain("unknown_pin");
  });

  test("dangling_pin", () => {
    const c = cleanBuck();
    c.components[3].pins[0].connects_to = []; // C2.1 dangles
    const { findings } = deriveNets(c);
    const f = findings.find((x) => x.code === "dangling_pin");
    expect(f?.where).toBe("C2.1");
  });

  test("nc_conflict", () => {
    const c = cleanBuck();
    c.components[0].pins[4].connects_to = ["NC", "VIN"];
    const { findings } = deriveNets(c);
    expect(codes(findings)).toContain("nc_conflict");
  });

  test("NC alone is fine", () => {
    const c = cleanBuck();
    c.components[0].pins[4].connects_to = ["NC"];
    const { findings } = deriveNets(c);
    expect(codes(findings)).not.toContain("nc_conflict");
    expect(codes(findings)).not.toContain("dangling_pin");
  });

  test("unreciprocated_connection", () => {
    const c = cleanBuck();
    // U1.1 says C1.1, but make C1.1 point elsewhere with no shared rail
    c.components[2].pins[0].connects_to = ["ISOLATED"];
    const { findings } = deriveNets(c);
    expect(codes(findings)).toContain("unreciprocated_connection");
  });

  test("shared-rail counts as reciprocation (no warning)", () => {
    const c = cleanBuck();
    // Both mention VIN, even though C1.1 doesn't list U1.1 back.
    c.components[2].pins[0].connects_to = ["VIN"];
    const { findings } = deriveNets(c);
    const unrec = findings.filter((f) => f.code === "unreciprocated_connection");
    // U1.1 -> C1.1 shares rail VIN, so not flagged.
    expect(unrec.find((f) => f.where === "U1.1 -> C1.1")).toBeUndefined();
  });

  test("undeclared_rail", () => {
    const c = cleanBuck();
    c.components[3].pins[0].connects_to = ["VOUT", "MYSTERY"]; // MYSTERY not in rails
    const { findings } = deriveNets(c);
    const f = findings.find((x) => x.code === "undeclared_rail");
    expect(f?.where).toBe("MYSTERY");
  });

  test("unused_rail", () => {
    const c = cleanBuck();
    c.rails.push("NEVERUSED");
    const { findings } = deriveNets(c);
    const f = findings.find((x) => x.code === "unused_rail");
    expect(f?.where).toBe("NEVERUSED");
  });

  test("singleton_net", () => {
    const circuit: ReferenceCircuit = {
      device: "X",
      title: "t",
      provenance: prov,
      rails: [],
      notes: [],
      confidence: "high",
      components: [
        {
          designator: "R1",
          kind: "resistor",
          pins: [
            { pin: "1", connects_to: ["R2.1"] },
            { pin: "2", connects_to: ["NC"] },
          ],
        },
        {
          designator: "R2",
          kind: "resistor",
          pins: [
            { pin: "1", connects_to: ["R1.1"] },
            { pin: "2", connects_to: ["NC"] },
          ],
        },
      ],
    };
    const { nets, findings } = deriveNets(circuit);
    // R1.1<->R2.1 form one net; no rails so it's synthesized N$1.
    expect(nets.find((n) => n.name === "N$1")?.members).toEqual(["R1.1", "R2.1"]);
    // No singletons here (both have 2 members via the pair). Add a real singleton.
    expect(codes(findings)).not.toContain("singleton_net");
  });

  test("singleton_net fires for a lone pin", () => {
    const circuit: ReferenceCircuit = {
      device: "X",
      title: "t",
      provenance: prov,
      rails: ["A"],
      notes: [],
      confidence: "high",
      components: [
        {
          designator: "R1",
          kind: "resistor",
          pins: [
            { pin: "1", connects_to: ["A"] },
            { pin: "2", connects_to: ["LONELY"] },
          ],
        },
      ],
    };
    const { findings } = deriveNets(circuit);
    // "LONELY" rail net has one member R1.2 → singleton.
    expect(codes(findings)).toContain("singleton_net");
  });

  test("rail_short when two rails merge", () => {
    const c = cleanBuck();
    // Short VIN to GND via C1.1 also connecting to GND.
    c.components[2].pins[0].connects_to = ["VIN", "U1.1", "GND"];
    const { findings } = deriveNets(c);
    expect(codes(findings)).toContain("rail_short");
  });

  test("synthetic nets are named deterministically", () => {
    const circuit: ReferenceCircuit = {
      device: "X",
      title: "t",
      provenance: prov,
      rails: [],
      notes: [],
      confidence: "high",
      components: [
        {
          designator: "R2",
          kind: "resistor",
          pins: [
            { pin: "1", connects_to: ["R1.1"] },
            { pin: "2", connects_to: ["R3.1"] },
          ],
        },
        {
          designator: "R1",
          kind: "resistor",
          pins: [
            { pin: "1", connects_to: ["R2.1"] },
            { pin: "2", connects_to: ["NC"] },
          ],
        },
        {
          designator: "R3",
          kind: "resistor",
          pins: [
            { pin: "1", connects_to: ["R2.2"] },
            { pin: "2", connects_to: ["NC"] },
          ],
        },
      ],
    };
    const a = deriveNets(circuit).nets;
    const b = deriveNets(circuit).nets;
    expect(a).toEqual(b); // deterministic
    // N$1 sorts before N$2 by first member; R1.1 group vs R2.2 group.
    const n1 = a.find((n) => n.name === "N$1");
    expect(n1?.members[0]).toBe("R1.1");
  });
});

describe("validatePinTable", () => {
  const base = (over: Partial<PinTable>): PinTable => ({
    device: "X",
    package: "SOT-23-5",
    pin_count: 5,
    pins: [
      { number: "1", name: "A", type: "input", provenance: prov },
      { number: "2", name: "B", type: "input", provenance: prov },
      { number: "3", name: "C", type: "input", provenance: prov },
      { number: "4", name: "D", type: "input", provenance: prov },
      { number: "5", name: "E", type: "input", provenance: prov },
    ],
    ...over,
  });

  test("clean table → no findings", () => {
    expect(validatePinTable(base({}))).toEqual([]);
  });

  test("pin_count_mismatch", () => {
    const t = base({ pin_count: 6 });
    expect(codes(validatePinTable(t))).toContain("pin_count_mismatch");
  });

  test("duplicate_pin", () => {
    const t = base({});
    t.pins[1].number = "1";
    const f = validatePinTable(t);
    expect(codes(f)).toContain("duplicate_pin");
  });

  test("package_pin_count warning", () => {
    // SOIC-8 but only 5 pins declared.
    const t = base({ package: "SOIC-8" });
    expect(codes(validatePinTable(t))).toContain("package_pin_count");
  });

  test("exposed pad allows +1", () => {
    const t: PinTable = {
      device: "X",
      package: "QFN-4",
      pin_count: 5,
      pins: [
        { number: "1", name: "A", type: "input", provenance: prov },
        { number: "2", name: "B", type: "input", provenance: prov },
        { number: "3", name: "C", type: "input", provenance: prov },
        { number: "4", name: "D", type: "input", provenance: prov },
        { number: "EP", name: "GND", type: "power_in", provenance: prov },
      ],
    };
    expect(codes(validatePinTable(t))).not.toContain("package_pin_count");
  });

  test("no parseable count → skip plausibility", () => {
    const t = base({ package: "TO-can" });
    expect(codes(validatePinTable(t))).not.toContain("package_pin_count");
  });
});

describe("validateSpecTable", () => {
  const spec = (over: Partial<SpecTable["items"][number]>): SpecTable => ({
    device: "X",
    section: "recommended_operating",
    items: [
      {
        parameter: "Input voltage",
        symbol: "VIN",
        value: { min: 3, typ: 5, max: 12, unit: "V" },
        provenance: prov,
        confidence: "high",
        ...over,
      },
    ],
    not_found: [],
  });

  test("clean spec → no findings", () => {
    expect(validateSpecTable(spec({}))).toEqual([]);
  });

  test("min_typ_max_order", () => {
    const s = spec({ value: { min: 12, typ: 5, max: 3, unit: "V" } });
    expect(codes(validateSpecTable(s))).toContain("min_typ_max_order");
  });

  test("empty_unit", () => {
    const s = spec({ value: { typ: 5, unit: "" } });
    expect(codes(validateSpecTable(s))).toContain("empty_unit");
  });

  test("no_value", () => {
    const s = spec({ value: { unit: "V" } });
    expect(codes(validateSpecTable(s))).toContain("no_value");
  });

  test("unit_class_mismatch (voltage param, current unit)", () => {
    const s = spec({ value: { typ: 5, unit: "A" } });
    expect(codes(validateSpecTable(s))).toContain("unit_class_mismatch");
  });

  test("no mismatch when unit class matches", () => {
    const s = spec({
      parameter: "Quiescent current",
      symbol: "IQ",
      value: { typ: 0.001, unit: "A" },
    });
    expect(codes(validateSpecTable(s))).not.toContain("unit_class_mismatch");
  });
});

describe("cross-check helpers", () => {
  test("packagesMatch is case/hyphen insensitive", () => {
    expect(packagesMatch("SOT-23-5", "sot235")).toBe(true);
    expect(packagesMatch("QFN-32", "QFN32")).toBe(true);
    expect(packagesMatch("SOT-23-5", "SOIC-8")).toBe(false);
  });

  test("crossCheckPackage flags mismatch", () => {
    expect(crossCheckPackage("SOT-23-5", "SOT-23-5")).toBeNull();
    const f = crossCheckPackage("SOT-23-5", "SOIC-8");
    expect(f?.code).toBe("lcsc_package_mismatch");
  });

  test("relativeQuantityDiff", () => {
    expect(relativeQuantityDiff("10µF", "0.00001F")).toBeCloseTo(0, 6);
    expect(relativeQuantityDiff("1000mA", "1A")).toBeCloseTo(0, 6);
    const d = relativeQuantityDiff("10µF", "22µF");
    expect(d).not.toBeNull();
    expect(d as number).toBeGreaterThan(0.05);
  });

  test("relativeQuantityDiff null on unit mismatch", () => {
    expect(relativeQuantityDiff("10V", "10A")).toBeNull();
  });

  test("fuzzyNameMatch", () => {
    expect(fuzzyNameMatch("Input voltage", "Input Voltage (VIN)")).toBe(true);
    expect(fuzzyNameMatch("VIN", "vin")).toBe(true);
    expect(fuzzyNameMatch("Input voltage", "Output current")).toBe(false);
  });

  test("crossCheckSpecs flags >5% disagreement", () => {
    const items: SpecTable["items"] = [
      {
        parameter: "Output voltage",
        symbol: "VOUT",
        value: { typ: 3.3, unit: "V" },
        provenance: prov,
        confidence: "high",
      },
    ];
    const findings = crossCheckSpecs(items, { "Output Voltage": "5V" });
    expect(codes(findings)).toContain("lcsc_value_mismatch");
  });

  test("crossCheckSpecs silent within tolerance", () => {
    const items: SpecTable["items"] = [
      {
        parameter: "Output voltage",
        value: { typ: 3.3, unit: "V" },
        provenance: prov,
        confidence: "high",
      },
    ];
    const findings = crossCheckSpecs(items, { "Output voltage": "3.31V" });
    expect(findings).toEqual([]);
  });
});
