import { describe, expect, test } from "bun:test";
import type { ReferenceCircuit } from "../schemas/datasheet.js";
import type { Netlist, NetlistComponent, NetlistNet } from "./netlist.js";
import {
  type CanonicalCircuit,
  chooseMatching,
  compareCircuits,
  fromKicadNetlist,
  fromReferenceCircuit,
  kindFromRef,
  valueComparable,
  valuesEquivalent,
} from "./refcircuit-compare.js";

// ── value comparison ──

describe("valueComparable / valuesEquivalent", () => {
  const cases: [string | undefined, string | undefined, "equal" | "different" | "incomparable"][] =
    [
      [undefined, undefined, "incomparable"],
      ["10µF", undefined, "incomparable"],
      ["10µF", "10uF", "equal"], // µ vs u
      ["10uF", "0.00001F", "equal"], // scale
      ["10µF", "22µF", "different"],
      ["2.2µH", "2.2uH", "equal"],
      ["100k", "100k", "equal"], // bare (loose parse, same "k" unit)
      ["100k", "31.6k", "different"],
      ["10µF", "10µH", "different"], // unit class differs
      ["X7R", "x7r", "equal"], // unparseable → normalized string compare
      ["NC", "DNP", "different"],
      ["100 nF", "100nF", "equal"], // whitespace
    ];
  for (const [a, b, expected] of cases) {
    test(`valueComparable(${a}, ${b}) = ${expected}`, () => {
      expect(valueComparable(a, b)).toBe(expected);
    });
  }

  test("valuesEquivalent: both undefined is true", () => {
    expect(valuesEquivalent(undefined, undefined)).toBe(true);
  });
  test("valuesEquivalent: one undefined is false", () => {
    expect(valuesEquivalent("10µF", undefined)).toBe(false);
  });
  test("valuesEquivalent: within 1% tolerance", () => {
    expect(valuesEquivalent("100.5kΩ", "100kΩ")).toBe(true);
    expect(valuesEquivalent("103kΩ", "100kΩ")).toBe(false);
  });
});

// ── kind mapping ──

describe("kindFromRef", () => {
  const cases: [string, string, string, string][] = [
    ["R12", "100k", "Device:R", "resistor"],
    ["C3", "10uF", "Device:C", "capacitor"],
    ["L1", "2.2uH", "Device:L", "inductor"],
    ["FB1", "600R", "Device:L", "ferrite"],
    ["D1", "1N4148", "Device:D", "diode"],
    ["D2", "GREEN", "Device:LED", "led"],
    ["D3", "LED_RED", "Device:D", "led"],
    ["Q1", "AO3400", "Device:Q_NMOS", "transistor"],
    ["U1", "MP2315", "Regulator:MP2315", "ic"],
    ["Y1", "16MHz", "Device:Crystal", "crystal"],
    ["X1", "32.768kHz", "Device:Crystal", "crystal"],
    ["J1", "USB", "Connector:USB_C", "connector"],
    ["CN2", "HDR", "Connector:Conn", "connector"],
    ["TP1", "test", "", "other"],
  ];
  for (const [ref, value, lib, expected] of cases) {
    test(`${ref} (${value}) → ${expected}`, () => {
      expect(kindFromRef(ref, value, lib)).toBe(expected);
    });
  }
});

// ── fromKicadNetlist ──

function comp(ref: string, value: string, libPart: string): NetlistComponent {
  return { ref, value, footprint: "", description: "", libPart, sheetName: "/", sheetFile: "" };
}
function net(code: number, name: string, nodes: [string, string, string?][]): NetlistNet {
  return {
    code,
    name,
    nodes: nodes.map(([ref, pin, pinFunction]) => ({
      ref,
      pin,
      pinFunction: pinFunction ?? "",
      pinType: "passive",
    })),
  };
}

describe("fromKicadNetlist", () => {
  const netlist: Netlist = {
    sheets: [],
    components: [
      comp("U1", "MP2315", "Regulator:MP2315"),
      comp("R1", "100k", "Device:R"),
      comp("C1", "10uF", "Device:C"),
      comp("#PWR01", "GND", "power:GND"),
    ],
    nets: [
      net(1, "/VIN", [
        ["U1", "1", "IN"],
        ["C1", "1"],
      ]),
      net(2, "GND", [
        ["U1", "2", "GND"],
        ["C1", "2"],
        ["R1", "2"],
        ["#PWR01", "1"],
      ]),
      net(3, "Net-(R1-Pad1)", [
        ["U1", "3", "FB"],
        ["R1", "1"],
      ]),
    ],
  };

  test("excludes power symbols, maps kinds, strips leading slash", () => {
    const canon = fromKicadNetlist(netlist, {});
    expect(canon.components.map((c) => c.id).sort()).toEqual(["C1", "R1", "U1"]);
    expect(canon.components.find((c) => c.id === "U1")?.kind).toBe("ic");
    const vin = canon.nets.find((n) => n.name === "VIN");
    expect(vin).toBeDefined();
    expect(vin?.members).toEqual(["C1.1", "U1.IN"]); // pinfunction preferred, sorted
    const gnd = canon.nets.find((n) => n.name === "GND");
    expect(gnd?.members).toEqual(["C1.2", "R1.2", "U1.GND"]); // #PWR01 dropped
  });

  test("refs scoping drops out-of-scope components and now-thin nets", () => {
    const canon = fromKicadNetlist(netlist, { refs: ["U1", "C1"] });
    expect(canon.components.map((c) => c.id).sort()).toEqual(["C1", "U1"]);
    // Net 3 had U1.FB + R1.1 → only U1.FB remains → dropped (<2 members).
    expect(canon.nets.find((n) => n.name === "Net-(R1-Pad1)")).toBeUndefined();
    expect(canon.nets.find((n) => n.name === "VIN")?.members).toEqual(["C1.1", "U1.IN"]);
  });
});

// ── Buck fixture (MP2315-style) ──

function goldenBuck(): ReferenceCircuit {
  return {
    device: "MP2315",
    title: "Typical Application",
    provenance: { page: 12, label: "Figure 1" },
    rails: ["VIN", "VOUT", "GND"],
    confidence: "high",
    notes: [],
    components: [
      {
        designator: "U1",
        kind: "ic",
        pins: [
          { pin: "IN", connects_to: ["VIN", "C1.1"] },
          { pin: "SW", connects_to: ["L1.1", "C3.2"] },
          { pin: "GND", connects_to: ["GND"] },
          { pin: "FB", connects_to: ["R1.2", "R2.1"] },
          { pin: "EN", connects_to: ["VIN"] },
          { pin: "BST", connects_to: ["C3.1"] },
        ],
      },
      {
        designator: "C1",
        kind: "capacitor",
        value: "10µF",
        pins: [
          { pin: "1", connects_to: ["VIN", "U1.IN"] },
          { pin: "2", connects_to: ["GND"] },
        ],
      },
      {
        designator: "C2",
        kind: "capacitor",
        value: "22µF",
        pins: [
          { pin: "1", connects_to: ["VOUT", "L1.2"] },
          { pin: "2", connects_to: ["GND"] },
        ],
      },
      {
        designator: "C3",
        kind: "capacitor",
        value: "100nF",
        pins: [
          { pin: "1", connects_to: ["U1.BST"] },
          { pin: "2", connects_to: ["U1.SW", "L1.1"] },
        ],
      },
      {
        designator: "L1",
        kind: "inductor",
        value: "2.2µH",
        pins: [
          { pin: "1", connects_to: ["U1.SW", "C3.2"] },
          { pin: "2", connects_to: ["VOUT", "C2.1"] },
        ],
      },
      {
        designator: "R1",
        kind: "resistor",
        value: "100k",
        pins: [
          { pin: "1", connects_to: ["VOUT"] },
          { pin: "2", connects_to: ["U1.FB", "R2.1"] },
        ],
      },
      {
        designator: "R2",
        kind: "resistor",
        value: "31.6k",
        pins: [
          { pin: "1", connects_to: ["U1.FB", "R1.2"] },
          { pin: "2", connects_to: ["GND"] },
        ],
      },
    ],
  };
}

// Perfect candidate: different designators, u-vs-µ values, named IC pins.
function candidatePerfect(): CanonicalCircuit {
  return {
    components: [
      { id: "U9", kind: "ic", pinCount: 6 },
      { id: "C11", kind: "capacitor", value: "10uF", pinCount: 2 },
      { id: "C12", kind: "capacitor", value: "22uF", pinCount: 2 },
      { id: "C13", kind: "capacitor", value: "100nF", pinCount: 2 },
      { id: "L9", kind: "inductor", value: "2.2uH", pinCount: 2 },
      { id: "R11", kind: "resistor", value: "100k", pinCount: 2 },
      { id: "R12", kind: "resistor", value: "31.6k", pinCount: 2 },
    ],
    nets: [
      { name: "VIN", members: ["C11.1", "U9.EN", "U9.IN"] },
      { name: "GND", members: ["C11.2", "C12.2", "R12.2", "U9.GND"] },
      { name: "VOUT", members: ["C12.1", "L9.2", "R11.1"] },
      { name: "Net-SW", members: ["C13.2", "L9.1", "U9.SW"] },
      { name: "Net-FB", members: ["R11.2", "R12.1", "U9.FB"] },
      { name: "Net-BST", members: ["C13.1", "U9.BST"] },
    ],
  };
}

describe("compareCircuits — buck fixture", () => {
  test("(a) perfect candidate: topologyPass, F1 1.0, values match", () => {
    const golden = fromReferenceCircuit(goldenBuck());
    const cmp = compareCircuits(golden, candidatePerfect());
    expect(cmp.metrics.topologyPass).toBe(true);
    expect(cmp.metrics.connectionF1).toBe(1);
    expect(cmp.metrics.componentRecall).toBe(1);
    expect(cmp.metrics.componentPrecision).toBe(1);
    expect(cmp.metrics.valueAccuracy).toBe(1);
    expect(cmp.metrics.netExactness).toBe(1);
    expect(cmp.valueMismatches).toEqual([]);
    expect(cmp.missingConnections).toEqual([]);
    expect(cmp.extraConnections).toEqual([]);
    // IC and inductor correctly paired despite different designators.
    expect(cmp.matching.find((m) => m.goldenId === "U1")?.candidateId).toBe("U9");
    expect(cmp.matching.find((m) => m.goldenId === "L1")?.candidateId).toBe("L9");
  });

  test("(b) missing feedback resistor: missingConnections + topology fail", () => {
    const golden = fromReferenceCircuit(goldenBuck());
    const candidate = candidatePerfect();
    // Drop R12 (the golden R2 match) and its members.
    candidate.components = candidate.components.filter((c) => c.id !== "R12");
    candidate.nets = candidate.nets.map((n) => ({
      name: n.name,
      members: n.members.filter((m) => !m.startsWith("R12.")),
    }));
    const cmp = compareCircuits(golden, candidate);
    expect(cmp.metrics.topologyPass).toBe(false);
    expect(cmp.unmatchedGolden).toContain("R2");
    const missingPins = cmp.missingConnections.flatMap((m) => m.pins);
    expect(missingPins).toContain("R2.1"); // FB divider connection is gone
  });

  test("(c) swapped divider values: value mismatch, topology preserved", () => {
    const golden = fromReferenceCircuit(goldenBuck());
    const candidate = candidatePerfect();
    // Swap the two divider values; positions/topology unchanged.
    for (const c of candidate.components) {
      if (c.id === "R11") c.value = "31.6k";
      if (c.id === "R12") c.value = "100k";
    }
    const cmp = compareCircuits(golden, candidate);
    // Matcher preserves topology (higher connection agreement) rather than
    // chasing the value match, so the swap surfaces as value mismatches.
    expect(cmp.metrics.connectionF1).toBe(1);
    expect(cmp.metrics.topologyPass).toBe(true);
    expect(cmp.valueMismatches.length).toBe(2);
    const mismatchGolden = cmp.valueMismatches.map((v) => v.goldenId).sort();
    expect(mismatchGolden).toEqual(["R1", "R2"]);
    expect(cmp.metrics.valueAccuracy).toBeLessThan(1);
  });
});

// ── matching: greedy vs exhaustive ──

describe("chooseMatching — exhaustive beats greedy", () => {
  const golden: CanonicalCircuit = {
    components: [
      { id: "U1", kind: "ic", pinCount: 2 },
      { id: "R1", kind: "resistor", value: "1k", pinCount: 2 },
      { id: "R2", kind: "resistor", value: "1k", pinCount: 2 },
    ],
    nets: [
      { name: "NA", members: ["R1.1", "U1.A"] },
      { name: "NB", members: ["R2.1", "U1.B"] },
      { name: "GND", members: ["R1.2", "R2.2"] },
    ],
  };
  // Ra is topologically R2 (on U.B), Rb is topologically R1 (on U.A).
  const candidate: CanonicalCircuit = {
    components: [
      { id: "Ux", kind: "ic", pinCount: 2 },
      { id: "Ra", kind: "resistor", value: "1k", pinCount: 2 },
      { id: "Rb", kind: "resistor", value: "1k", pinCount: 2 },
    ],
    nets: [
      { name: "NA", members: ["Rb.1", "Ux.A"] },
      { name: "NB", members: ["Ra.1", "Ux.B"] },
      { name: "GND", members: ["Ra.2", "Rb.2"] },
    ],
  };

  test("greedy picks the wrong (equal-value) resistor", () => {
    const greedy = chooseMatching(golden, candidate, "greedy");
    expect(greedy.find(([g]) => g === "R1")?.[1]).toBe("Ra"); // suboptimal
  });

  test("exhaustive (default) recovers the topology-correct matching", () => {
    const cmp = compareCircuits(golden, candidate);
    expect(cmp.matching.find((m) => m.goldenId === "R1")?.candidateId).toBe("Rb");
    expect(cmp.metrics.connectionF1).toBe(1);
    expect(cmp.metrics.topologyPass).toBe(true);
  });
});

// ── edge cases ──

describe("compareCircuits — edge cases", () => {
  const empty: CanonicalCircuit = { components: [], nets: [] };

  test("both empty → perfect scores", () => {
    const cmp = compareCircuits(empty, empty);
    expect(cmp.metrics.topologyPass).toBe(true);
    expect(cmp.metrics.connectionF1).toBe(1);
    expect(cmp.metrics.netExactness).toBe(1);
    expect(cmp.metrics.valueAccuracy).toBe(1);
  });

  test("golden empty, candidate non-empty → not a topology pass", () => {
    const candidate: CanonicalCircuit = {
      components: [{ id: "R1", kind: "resistor", pinCount: 2 }],
      nets: [],
    };
    const cmp = compareCircuits(empty, candidate);
    expect(cmp.metrics.topologyPass).toBe(false);
    expect(cmp.unmatchedCandidate).toEqual(["R1"]);
  });

  test("candidate superset: extra component flagged, topology fails", () => {
    const golden: CanonicalCircuit = {
      components: [
        { id: "U1", kind: "ic", pinCount: 2 },
        { id: "C1", kind: "capacitor", value: "1uF", pinCount: 2 },
      ],
      nets: [
        { name: "VCC", members: ["C1.1", "U1.1"] },
        { name: "GND", members: ["C1.2", "U1.2"] },
      ],
    };
    const candidate: CanonicalCircuit = {
      components: [
        { id: "Ua", kind: "ic", pinCount: 2 },
        { id: "Ca", kind: "capacitor", value: "1uF", pinCount: 2 },
        { id: "Cb", kind: "capacitor", value: "100nF", pinCount: 2 },
      ],
      nets: [
        { name: "VCC", members: ["Ca.1", "Cb.1", "Ua.1"] },
        { name: "GND", members: ["Ca.2", "Cb.2", "Ua.2"] },
      ],
    };
    const cmp = compareCircuits(golden, candidate);
    expect(cmp.unmatchedCandidate).toEqual(["Cb"]);
    expect(cmp.metrics.componentRecall).toBe(1);
    expect(cmp.metrics.componentPrecision).toBeCloseTo(2 / 3);
    expect(cmp.metrics.topologyPass).toBe(false); // extra Cb adds connections
    expect(cmp.extraConnections.length).toBeGreaterThan(0);
  });
});

// ── IC pin granularity (numeric vs named) ──

describe("compareCircuits — IC pin granularity", () => {
  const golden: CanonicalCircuit = {
    components: [
      { id: "U1", kind: "ic", pinCount: 2 },
      { id: "R1", kind: "resistor", value: "10k", pinCount: 2 },
      { id: "R2", kind: "resistor", value: "20k", pinCount: 2 },
    ],
    nets: [
      { name: "N1", members: ["R1.1", "U1.IN"] },
      { name: "N2", members: ["R2.1", "U1.OUT"] },
      { name: "GND", members: ["R1.2", "R2.2"] },
    ],
  };

  test("numeric candidate IC pins collapse to component granularity, still passes", () => {
    // Candidate IC uses numeric pins → cannot align by name → granular.
    const candidate: CanonicalCircuit = {
      components: [
        { id: "Ux", kind: "ic", pinCount: 2 },
        { id: "Ra", kind: "resistor", value: "10k", pinCount: 2 },
        { id: "Rb", kind: "resistor", value: "20k", pinCount: 2 },
      ],
      nets: [
        { name: "N1", members: ["Ra.1", "Ux.1"] },
        { name: "N2", members: ["Rb.1", "Ux.2"] },
        { name: "GND", members: ["Ra.2", "Rb.2"] },
      ],
    };
    const cmp = compareCircuits(golden, candidate);
    expect(cmp.metrics.connectionF1).toBe(1);
    expect(cmp.metrics.topologyPass).toBe(true);
  });

  test("granularity does not inflate F1 when a real connection is missing", () => {
    // Candidate IC only connects to Ra; R2/Rb link absent → must be detected.
    const candidate: CanonicalCircuit = {
      components: [
        { id: "Ux", kind: "ic", pinCount: 1 },
        { id: "Ra", kind: "resistor", value: "10k", pinCount: 2 },
        { id: "Rb", kind: "resistor", value: "20k", pinCount: 2 },
      ],
      nets: [
        { name: "N1", members: ["Ra.1", "Ux.1"] },
        { name: "GND", members: ["Ra.2", "Rb.2"] },
      ],
    };
    const cmp = compareCircuits(golden, candidate);
    expect(cmp.metrics.topologyPass).toBe(false);
    expect(cmp.metrics.connectionF1).toBeLessThan(1);
    const missingPins = cmp.missingConnections.flatMap((m) => m.pins);
    expect(missingPins).toContain("U1.OUT");
  });
});

// ── swapped connections / rail rename ──

describe("compareCircuits — swapped connections & rails", () => {
  test("identical-value resistors swapped is electrically invisible (pass)", () => {
    const golden: CanonicalCircuit = {
      components: [
        { id: "U1", kind: "ic", pinCount: 1 },
        { id: "R1", kind: "resistor", value: "100k", pinCount: 2 },
        { id: "R2", kind: "resistor", value: "100k", pinCount: 2 },
      ],
      nets: [
        { name: "VOUT", members: ["R1.1"] },
        { name: "FB", members: ["R1.2", "R2.1", "U1.FB"] },
        { name: "GND", members: ["R2.2"] },
      ],
    };
    // R positions swapped, but both are 100k → symmetric, no defect.
    const candidate: CanonicalCircuit = {
      components: [
        { id: "U1", kind: "ic", pinCount: 1 },
        { id: "Ra", kind: "resistor", value: "100k", pinCount: 2 },
        { id: "Rb", kind: "resistor", value: "100k", pinCount: 2 },
      ],
      nets: [
        { name: "VOUT", members: ["Rb.1"] },
        { name: "FB", members: ["Ra.1", "Rb.2", "U1.FB"] },
        { name: "GND", members: ["Ra.2"] },
      ],
    };
    const cmp = compareCircuits(golden, candidate);
    expect(cmp.metrics.topologyPass).toBe(true);
    expect(cmp.valueMismatches).toEqual([]);
  });

  test("mis-wired feedback (structural) shows missing/extra connections", () => {
    const golden: CanonicalCircuit = {
      components: [
        { id: "U1", kind: "ic", pinCount: 1 },
        { id: "R1", kind: "resistor", value: "100k", pinCount: 2 },
      ],
      nets: [
        { name: "VOUT", members: ["R1.1"] },
        { name: "FB", members: ["R1.2", "U1.FB"] },
      ],
    };
    // R1 top pin wrongly tied to VIN net with the IC instead of a clean VOUT.
    const candidate: CanonicalCircuit = {
      components: [
        { id: "U1", kind: "ic", pinCount: 1 },
        { id: "Ra", kind: "resistor", value: "100k", pinCount: 2 },
      ],
      nets: [{ name: "VIN", members: ["Ra.1", "Ra.2", "U1.FB"] }],
    };
    const cmp = compareCircuits(golden, candidate);
    expect(cmp.metrics.topologyPass).toBe(false);
    expect(cmp.missingConnections.length + cmp.extraConnections.length).toBeGreaterThan(0);
  });

  test("rail rename (VIN vs /VIN via netlist) does not break topology", () => {
    const golden = fromReferenceCircuit({
      device: "X",
      title: "t",
      provenance: { page: 1, label: "Fig 1" },
      rails: ["VIN", "GND"],
      confidence: "high",
      notes: [],
      components: [
        {
          designator: "R1",
          kind: "resistor",
          value: "10k",
          pins: [
            { pin: "1", connects_to: ["VIN", "C1.1"] },
            { pin: "2", connects_to: ["GND"] },
          ],
        },
        {
          designator: "C1",
          kind: "capacitor",
          value: "1uF",
          pins: [
            { pin: "1", connects_to: ["VIN", "R1.1"] },
            { pin: "2", connects_to: ["GND"] },
          ],
        },
      ],
    });
    const netlist: Netlist = {
      sheets: [],
      components: [comp("R1", "10k", "Device:R"), comp("C1", "1uF", "Device:C")],
      nets: [
        net(1, "/VIN", [
          ["R1", "1"],
          ["C1", "1"],
        ]),
        net(2, "GND", [
          ["R1", "2"],
          ["C1", "2"],
        ]),
      ],
    };
    const candidate = fromKicadNetlist(netlist, {});
    expect(candidate.nets.some((n) => n.name === "VIN")).toBe(true); // "/" stripped
    const cmp = compareCircuits(golden, candidate);
    expect(cmp.metrics.topologyPass).toBe(true);
  });
});
