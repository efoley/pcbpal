import { describe, expect, test } from "bun:test";
import type { ReferenceCircuit } from "../../src/schemas/datasheet.js";
import {
  extractJson,
  mergeCircuits,
  type StrategyContext,
  selfConsistency3,
  singlePass,
  validateRetry,
  verifier,
} from "./strategies.js";
import { MockTransport } from "./transport.js";
import type { Facet } from "./types.js";

function ctx(facet: Facet, responses: string[]): StrategyContext {
  return {
    part: { id: "x", mpn: "X" },
    facet,
    images: [],
    prompt: "extract",
    schemaJson: "{}",
    transport: new MockTransport(responses),
    model: { id: "test-model", maxTokens: 1000 },
  };
}

// ── JSON extraction ──

describe("extractJson", () => {
  test("plain object", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });
  test("fenced block", () => {
    expect(extractJson('here:\n```json\n{"a":1}\n```\nok')).toBe('{"a":1}');
  });
  test("no object", () => {
    expect(extractJson("nothing here")).toBeNull();
  });
});

// ── fixtures ──

interface SpecItemLite {
  parameter: string;
  symbol?: string;
  value: Record<string, unknown>;
  confidence?: string;
}
function specItem(o: SpecItemLite): Record<string, unknown> {
  return {
    parameter: o.parameter,
    ...(o.symbol ? { symbol: o.symbol } : {}),
    value: o.value,
    provenance: { page: 1, label: "T" },
    confidence: o.confidence ?? "high",
  };
}
function specsExt(items: Record<string, unknown>[]): string {
  return JSON.stringify({
    schema_version: 1,
    facet: "specs",
    device: "X",
    payload: { device: "X", section: "electrical_characteristics", items, not_found: [] },
  });
}
function circuitExt(payload: ReferenceCircuit): string {
  return JSON.stringify({ schema_version: 1, facet: "circuit", device: payload.device, payload });
}

// ── single-pass ──

describe("singlePass", () => {
  test("parses a valid extraction in one call", async () => {
    const res = await singlePass(
      ctx("specs", [specsExt([specItem({ parameter: "VO", value: { typ: 3.3, unit: "V" } })])]),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.calls).toBe(1);
      expect(res.extraction.facet).toBe("specs");
    }
  });

  test("retries once on malformed output then succeeds", async () => {
    const good = specsExt([specItem({ parameter: "VO", value: { typ: 3.3, unit: "V" } })]);
    const res = await singlePass(ctx("specs", ["not json at all", good]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.calls).toBe(2);
  });

  test("fails after two malformed responses (total omission)", async () => {
    const res = await singlePass(ctx("specs", ["garbage", "still garbage"]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.calls).toBe(2);
  });
});

// ── validate-retry ──

describe("validateRetry", () => {
  test("feeds deterministic errors back once and returns the correction", async () => {
    const bad = specsExt([specItem({ parameter: "Vo", value: { min: 5, max: 1, unit: "V" } })]); // min>max error
    const good = specsExt([specItem({ parameter: "Vo", value: { min: 1, max: 5, unit: "V" } })]);
    const res = await validateRetry(ctx("specs", [bad, good]));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.calls).toBe(2);
      if (res.extraction.facet === "specs") {
        expect(res.extraction.payload.items[0].value.min).toBe(1);
      }
    }
  });

  test("clean output needs no retry (single call)", async () => {
    const good = specsExt([specItem({ parameter: "Vo", value: { typ: 3.3, unit: "V" } })]);
    const res = await validateRetry(ctx("specs", [good]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.calls).toBe(1);
  });
});

// ── verifier ──

describe("verifier", () => {
  test("drops items the verifier marks wrong", async () => {
    const first = specsExt([
      specItem({ parameter: "A", symbol: "A", value: { typ: 1, unit: "V" } }),
      specItem({ parameter: "B", symbol: "B", value: { typ: 2, unit: "V" } }),
    ]);
    const verdicts = JSON.stringify({ verdicts: [{ ref: "B", verdict: "wrong" }] });
    const res = await verifier(ctx("specs", [first, verdicts]));
    expect(res.ok).toBe(true);
    if (res.ok && res.extraction.facet === "specs") {
      expect(res.extraction.payload.items.map((i) => i.symbol)).toEqual(["A"]);
      expect(res.calls).toBe(2);
    }
  });
});

// ── self-consistency ×3 ──

function circA(): ReferenceCircuit {
  return {
    device: "X",
    title: "t",
    provenance: { page: 1, label: "Fig 1" },
    rails: ["GND"],
    confidence: "high",
    notes: [],
    components: [
      { designator: "U1", kind: "ic", value: "IC", pins: [{ pin: "A", connects_to: ["R1.1"] }] },
      {
        designator: "R1",
        kind: "resistor",
        value: "10k",
        pins: [
          { pin: "1", connects_to: ["U1.A"] },
          { pin: "2", connects_to: ["GND"] },
        ],
      },
    ],
  };
}

function circWithSpurious(): ReferenceCircuit {
  const c = circA();
  // Add a spurious resistor and a spurious extra connection on R1.2 (1/3 runs).
  c.components[1].pins[1].connects_to = ["GND", "R2.1"];
  c.components.push({
    designator: "R2",
    kind: "resistor",
    value: "20k",
    pins: [
      { pin: "1", connects_to: ["R1.2"] },
      { pin: "2", connects_to: ["GND"] },
    ],
  });
  return c;
}

describe("selfConsistency3", () => {
  test("keeps quorum components/connections, drops the 1/3 outliers", async () => {
    const res = await selfConsistency3(
      ctx("circuit", [circuitExt(circA()), circuitExt(circA()), circuitExt(circWithSpurious())]),
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.extraction.facet === "circuit") {
      const ids = res.extraction.payload.components.map((c) => c.designator).sort();
      expect(ids).toEqual(["R1", "U1"]); // R2 (1/3) dropped
      const r1 = res.extraction.payload.components.find((c) => c.designator === "R1");
      const pin2 = r1?.pins.find((p) => p.pin === "2");
      expect(pin2?.connects_to).toEqual(["GND"]); // spurious R2.1 dropped
      expect(res.calls).toBe(3);
    }
  });

  test("rejects a non-circuit facet", async () => {
    const res = await selfConsistency3(ctx("specs", []));
    expect(res.ok).toBe(false);
  });
});

// ── mergeCircuits direct ──

describe("mergeCircuits", () => {
  test("3 identical circuits merge to the same topology", () => {
    const merged = mergeCircuits([circA(), circA(), circA()]);
    expect(merged.components.map((c) => c.designator).sort()).toEqual(["R1", "U1"]);
    expect(merged.rails).toEqual(["GND"]);
  });
});
