import { describe, expect, test } from "bun:test";
import type { ReferenceCircuit } from "../../src/schemas/datasheet.js";
import { type CircuitScoreDetail, scoreCircuit } from "./score-circuit.js";

// Minimal LDO: U1 (IC, named pins) + input cap + output cap.
function goldenLdo(): ReferenceCircuit {
  return {
    device: "LDO",
    title: "Typical Application",
    provenance: { page: 1, label: "Figure 1" },
    rails: ["VIN", "VOUT", "GND"],
    confidence: "high",
    notes: [],
    components: [
      {
        designator: "U1",
        kind: "ic",
        value: "LDO",
        pins: [
          { pin: "VIN", connects_to: ["VIN", "C1.1"] },
          { pin: "VOUT", connects_to: ["VOUT", "C2.1"] },
          { pin: "GND", connects_to: ["GND"] },
        ],
      },
      {
        designator: "C1",
        kind: "capacitor",
        value: "10µF",
        pins: [
          { pin: "1", connects_to: ["VIN", "U1.VIN"] },
          { pin: "2", connects_to: ["GND"] },
        ],
      },
      {
        designator: "C2",
        kind: "capacitor",
        value: "22µF",
        pins: [
          { pin: "1", connects_to: ["VOUT", "U1.VOUT"] },
          { pin: "2", connects_to: ["GND"] },
        ],
      },
    ],
  };
}

const detailOf = (s: ReturnType<typeof scoreCircuit>): CircuitScoreDetail =>
  s.detail as unknown as CircuitScoreDetail;

describe("scoreCircuit", () => {
  test("identical topology passes with F1 = 1", () => {
    const s = scoreCircuit(goldenLdo(), goldenLdo());
    expect(s.topologyPass).toBe(true);
    expect(s.headline).toBe(1);
    expect(s.hallucination_rate).toBe(0);
    expect(detailOf(s).valueAccuracy).toBe(1);
  });

  test("relabeled designators + µ/u values still pass (matched by kind/topology)", () => {
    const cand = goldenLdo();
    cand.components[0].designator = "IC5";
    cand.components[1].designator = "Cin";
    cand.components[1].value = "10uF";
    cand.components[2].designator = "Cout";
    cand.components[2].value = "22uF";
    // rewrite pin refs to the new designators
    cand.components[0].pins = [
      { pin: "VIN", connects_to: ["VIN", "Cin.1"] },
      { pin: "VOUT", connects_to: ["VOUT", "Cout.1"] },
      { pin: "GND", connects_to: ["GND"] },
    ];
    cand.components[1].pins = [
      { pin: "1", connects_to: ["VIN", "IC5.VIN"] },
      { pin: "2", connects_to: ["GND"] },
    ];
    cand.components[2].pins = [
      { pin: "1", connects_to: ["VOUT", "IC5.VOUT"] },
      { pin: "2", connects_to: ["GND"] },
    ];
    const s = scoreCircuit(goldenLdo(), cand);
    expect(s.topologyPass).toBe(true);
    expect(s.headline).toBe(1);
  });

  test("missing output cap → missed component, topology fails", () => {
    const cand = goldenLdo();
    cand.components = cand.components.filter((c) => c.designator !== "C2");
    // U1.VOUT no longer references C2
    cand.components[0].pins[1].connects_to = ["VOUT"];
    const s = scoreCircuit(goldenLdo(), cand);
    expect(s.topologyPass).toBe(false);
    expect(detailOf(s).missed_components).toBe(1);
    expect(s.headline).toBeLessThan(1);
  });

  test("hallucinated extra cap → hallucinated component + rate", () => {
    const cand = goldenLdo();
    cand.components.push({
      designator: "C99",
      kind: "capacitor",
      value: "100nF",
      pins: [
        { pin: "1", connects_to: ["VIN"] },
        { pin: "2", connects_to: ["GND"] },
      ],
    });
    const s = scoreCircuit(goldenLdo(), cand);
    const d = detailOf(s);
    expect(d.hallucinated_components).toBe(1);
    expect(s.hallucination_rate).toBeCloseTo(1 / 4);
    expect(s.topologyPass).toBe(false);
  });

  test("swapped-in wrong value surfaces as value mismatch, topology intact", () => {
    const cand = goldenLdo();
    cand.components[1].value = "1µF"; // input cap wrong value
    const s = scoreCircuit(goldenLdo(), cand);
    expect(s.topologyPass).toBe(true);
    expect(detailOf(s).valueAccuracy).toBeLessThan(1);
  });
});
