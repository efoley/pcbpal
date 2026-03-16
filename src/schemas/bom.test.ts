import { describe, expect, test } from "bun:test";
import { BomCategory, BomDatabase, BomEntry, BomStatus, PartSource } from "./bom.js";

describe("BomDatabase schema", () => {
  test("parses a valid empty database", () => {
    const result = BomDatabase.parse({
      schema_version: 1,
      entries: [],
    });
    expect(result.schema_version).toBe(1);
    expect(result.entries).toEqual([]);
  });

  test("rejects wrong schema_version", () => {
    expect(() => BomDatabase.parse({ schema_version: 2, entries: [] })).toThrow();
  });

  test("parses a full BOM entry", () => {
    const now = new Date().toISOString();
    const db = BomDatabase.parse({
      schema_version: 1,
      entries: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          role: "Decoupling cap",
          category: "passive",
          manufacturer: "Samsung",
          mpn: "CL05B104KO5NNNC",
          sources: [{ supplier: "lcsc", part_number: "C1525", stock: 1000 }],
          kicad_refs: ["C1", "C2"],
          status: "selected",
          added: now,
          updated: now,
        },
      ],
    });
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].role).toBe("Decoupling cap");
    expect(db.entries[0].sources[0].supplier).toBe("lcsc");
    expect(db.entries[0].kicad_refs).toEqual(["C1", "C2"]);
  });

  test("defaults status to candidate", () => {
    const now = new Date().toISOString();
    const entry = BomEntry.parse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      role: "test",
      category: "other",
      added: now,
      updated: now,
    });
    expect(entry.status).toBe("candidate");
  });

  test("defaults sources and kicad_refs to empty arrays", () => {
    const now = new Date().toISOString();
    const entry = BomEntry.parse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      role: "test",
      category: "other",
      added: now,
      updated: now,
    });
    expect(entry.sources).toEqual([]);
    expect(entry.kicad_refs).toEqual([]);
    expect(entry.alternates).toEqual([]);
  });

  test("rejects invalid category", () => {
    expect(() => BomCategory.parse("invalid_category")).toThrow();
  });

  test("accepts all valid categories", () => {
    const categories = [
      "ic",
      "passive",
      "connector",
      "antenna",
      "crystal",
      "inductor",
      "diode",
      "led",
      "transistor",
      "sensor",
      "power",
      "mechanical",
      "other",
    ];
    for (const cat of categories) {
      expect(BomCategory.parse(cat)).toBe(cat);
    }
  });

  test("rejects invalid status", () => {
    expect(() => BomStatus.parse("unknown")).toThrow();
  });

  test("validates PartSource url field", () => {
    expect(() =>
      PartSource.parse({
        supplier: "lcsc",
        part_number: "C1525",
        url: "not-a-url",
      }),
    ).toThrow();

    const valid = PartSource.parse({
      supplier: "lcsc",
      part_number: "C1525",
      url: "https://lcsc.com/product/C1525",
    });
    expect(valid.url).toBe("https://lcsc.com/product/C1525");
  });

  test("rejects invalid UUID for entry id", () => {
    const now = new Date().toISOString();
    expect(() =>
      BomEntry.parse({
        id: "not-a-uuid",
        role: "test",
        category: "other",
        added: now,
        updated: now,
      }),
    ).toThrow();
  });
});
