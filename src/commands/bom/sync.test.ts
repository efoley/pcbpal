import { describe, expect, test } from "bun:test";
import type { BomEntry } from "../../schemas/bom.js";
import type { KicadComponent } from "../../services/kicad.js";
import { matchSchematicToBom } from "./sync.js";

function comp(ref: string, value: string, footprint: string): KicadComponent {
  return { ref, value, footprint, libId: "Device:X", description: "", datasheet: "~" };
}

function entry(id: string, kicad_refs: string[], kicad_footprint?: string): BomEntry {
  return {
    id,
    role: "r",
    category: "passive",
    sources: [],
    kicad_refs,
    ...(kicad_footprint ? { kicad_footprint } : {}),
    alternates: [],
    status: "candidate",
    added: "2026-07-06T00:00:00.000Z",
    updated: "2026-07-06T00:00:00.000Z",
  };
}

const R = "Resistor_SMD:R_0603_1608Metric";
const C = "Capacitor_SMD:C_0402_1005Metric";

describe("matchSchematicToBom", () => {
  test("clean 1:1 maps each ref to its entry", () => {
    const m = matchSchematicToBom(
      [comp("R1", "10k", R), comp("C1", "100nF", C)],
      [entry("e-r", ["R1"], R), entry("e-c", ["C1"], C)],
    );
    expect(m.refToEntry).toEqual({ R1: "e-r", C1: "e-c" });
    expect(m.unmatchedSchRefs).toEqual([]);
    expect(m.orphanedEntryIds).toEqual([]);
  });

  test("multi-ref passives fold onto the one entry that shares a ref", () => {
    const m = matchSchematicToBom(
      [comp("R1", "10k", R), comp("R2", "10k", R), comp("R3", "10k", R)],
      [entry("e-r", ["R1"], R)],
    );
    expect(m.refToEntry).toEqual({ R1: "e-r", R2: "e-r", R3: "e-r" });
  });

  test("schematic component absent from BOM is unmatched", () => {
    const m = matchSchematicToBom([comp("D1", "1N4148", "Diode:D")], [entry("e-r", ["R9"], R)]);
    expect(m.unmatchedSchRefs).toEqual(["D1"]);
    // R9 has no schematic ref → the entry is orphaned.
    expect(m.orphanedEntryIds).toEqual(["e-r"]);
  });

  test("footprint mismatch is flagged, not clean-matched", () => {
    const m = matchSchematicToBom(
      [comp("C5", "10uF", "Capacitor_SMD:C_0805_2012Metric")],
      [entry("e-c", ["C5"], "Capacitor_SMD:C_0603_1608Metric")],
    );
    expect(m.refToEntry.C5).toBeUndefined();
    expect(m.footprintMismatches).toEqual(["C5"]);
  });

  test("a group spanning two entries is ambiguous", () => {
    const m = matchSchematicToBom(
      [comp("R1", "10k", R), comp("R2", "10k", R)],
      [entry("e-a", ["R1"], R), entry("e-b", ["R2"], R)],
    );
    expect(m.ambiguousRefs).toEqual(["R1", "R2"]);
    expect(m.refToEntry).toEqual({});
  });
});
