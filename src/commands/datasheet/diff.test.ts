import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReferenceCircuit } from "../../schemas/datasheet.js";
import type { Netlist, NetlistComponent, NetlistNet } from "../../services/netlist.js";
import { diffAgainstNetlist, diffCircuit } from "./diff.js";

// ── fixtures ──

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

function circuitExtraction(payload: ReferenceCircuit) {
  return {
    schema_version: 1 as const,
    facet: "circuit" as const,
    device: payload.device,
    payload,
  };
}

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

/** Netlist that mirrors the golden buck (with KiCad power symbols + refdes). */
function buckNetlist(opts: { dropR2?: boolean } = {}): Netlist {
  const components: NetlistComponent[] = [
    comp("U1", "MP2315", "Regulator_Switching:MP2315"),
    comp("L1", "2.2uH", "Device:L"),
    comp("C1", "10uF", "Device:C"),
    comp("C2", "22uF", "Device:C"),
    comp("C3", "100nF", "Device:C"),
    comp("R1", "100k", "Device:R"),
    comp("#PWR01", "GND", "power:GND"),
    comp("#PWR02", "VIN", "power:VIN"),
    comp("#PWR03", "VOUT", "power:+VOUT"),
  ];
  if (!opts.dropR2) components.push(comp("R2", "31.6k", "Device:R"));

  const gndNodes: [string, string, string?][] = [
    ["U1", "3", "GND"],
    ["C1", "2"],
    ["C2", "2"],
    ["#PWR01", "1"],
  ];
  const fbNodes: [string, string, string?][] = [
    ["U1", "4", "FB"],
    ["R1", "2"],
  ];
  if (!opts.dropR2) {
    gndNodes.push(["R2", "2"]);
    fbNodes.push(["R2", "1"]);
  }

  return {
    sheets: [],
    components,
    nets: [
      net(1, "VIN", [
        ["U1", "1", "IN"],
        ["C1", "1"],
        ["U1", "5", "EN"],
        ["#PWR02", "1"],
      ]),
      net(2, "GND", gndNodes),
      net(3, "VOUT", [
        ["L1", "2"],
        ["C2", "1"],
        ["R1", "1"],
        ["#PWR03", "1"],
      ]),
      net(4, "Net-(L1-Pad1)", [
        ["U1", "2", "SW"],
        ["L1", "1"],
        ["C3", "2"],
      ]),
      net(5, "Net-(R1-Pad2)", fbNodes),
      net(6, "Net-(C3-Pad1)", [
        ["U1", "6", "BST"],
        ["C3", "1"],
      ]),
    ],
  };
}

// ── diffAgainstNetlist ──

describe("diffAgainstNetlist — auto-scoping", () => {
  test("auto-scopes to the target IC + 1-hop neighborhood and passes", () => {
    const result = diffAgainstNetlist(circuitExtraction(goldenBuck()), buckNetlist(), {});
    expect(result.device).toBe("MP2315");
    // Power symbols excluded; all real neighbors in scope.
    expect(result.comparedRefs).toEqual(["C1", "C2", "C3", "L1", "R1", "R2", "U1"]);
    expect(result.ok).toBe(true);
    expect(result.comparison.metrics.topologyPass).toBe(true);
    expect(result.comparison.metrics.connectionF1).toBe(1);
    expect(result.hints).toEqual([]);
  });

  test("explicit refs override auto-scoping", () => {
    const refs = ["U1", "L1", "C1", "C2", "C3", "R1", "R2"];
    const result = diffAgainstNetlist(circuitExtraction(goldenBuck()), buckNetlist(), { refs });
    expect(result.comparedRefs).toEqual([...refs].sort());
    expect(result.ok).toBe(true);
  });

  test("missing feedback resistor in schematic → not ok, hints explain", () => {
    const result = diffAgainstNetlist(
      circuitExtraction(goldenBuck()),
      buckNetlist({ dropR2: true }),
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.comparison.unmatchedGolden).toContain("R2");
    expect(result.hints.length).toBeGreaterThan(0);
    expect(result.hints.some((h) => h.includes("R2"))).toBe(true);
  });

  test("device not found → helpful error listing candidates", () => {
    const extraction = circuitExtraction({ ...goldenBuck(), device: "NONEXISTENT9000" });
    expect(() => diffAgainstNetlist(extraction, buckNetlist(), {})).toThrow(
      /Could not find a component matching device "NONEXISTENT9000"/,
    );
  });
});

// ── diffCircuit file/validation errors (no project needed) ──

describe("diffCircuit — input validation", () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "pcbpal-diff-test-"));
  });
  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("throws on missing file", async () => {
    await expect(diffCircuit({ file: join(testDir, "nope.json") })).rejects.toThrow("Cannot read");
  });

  test("throws on malformed JSON", async () => {
    const file = join(testDir, "bad.json");
    await writeFile(file, "{ not json", "utf-8");
    await expect(diffCircuit({ file })).rejects.toThrow("not valid JSON");
  });

  test("rejects a non-circuit facet", async () => {
    const file = join(testDir, "specs.json");
    await writeFile(
      file,
      JSON.stringify({
        schema_version: 1,
        facet: "specs",
        device: "X",
        payload: { device: "X", section: "thermal", items: [], not_found: [] },
      }),
      "utf-8",
    );
    await expect(diffCircuit({ file })).rejects.toThrow(/requires a "circuit" extraction/);
  });

  test("rejects a schema-invalid circuit", async () => {
    const file = join(testDir, "bad-circuit.json");
    await writeFile(
      file,
      JSON.stringify({ schema_version: 1, facet: "circuit", device: "X", payload: {} }),
      "utf-8",
    );
    await expect(diffCircuit({ file })).rejects.toThrow(/failed schema validation/);
  });
});
