import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExtraction } from "./validate.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "pcbpal-datasheet-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const prov = { page: 1, label: "Table 1" };

async function writeExtraction(name: string, obj: unknown): Promise<string> {
  const path = join(testDir, name);
  await writeFile(path, JSON.stringify(obj, null, 2), "utf-8");
  return path;
}

describe("validateExtraction — specs", () => {
  test("clean specs extraction validates ok", async () => {
    const file = await writeExtraction("specs.json", {
      schema_version: 1,
      facet: "specs",
      device: "AMS1117-3.3",
      payload: {
        device: "AMS1117-3.3",
        section: "recommended_operating",
        items: [
          {
            parameter: "Input voltage",
            symbol: "VIN",
            value: { min: 4.75, typ: 5, max: 15, unit: "V" },
            provenance: prov,
            confidence: "high",
          },
        ],
        not_found: [],
      },
    });
    const result = await validateExtraction({ file });
    expect(result.ok).toBe(true);
    expect(result.facet).toBe("specs");
    expect(result.device).toBe("AMS1117-3.3");
    expect(result.stats.items).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test("bad unit class produces a warning but stays ok", async () => {
    const file = await writeExtraction("specs.json", {
      schema_version: 1,
      facet: "specs",
      device: "X",
      payload: {
        device: "X",
        section: "recommended_operating",
        items: [
          {
            parameter: "Input voltage",
            symbol: "VIN",
            value: { typ: 5, unit: "A" },
            provenance: prov,
            confidence: "high",
          },
        ],
      },
    });
    const result = await validateExtraction({ file });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain("unit_class_mismatch");
  });

  test("min>max fails validation", async () => {
    const file = await writeExtraction("specs.json", {
      schema_version: 1,
      facet: "specs",
      device: "X",
      payload: {
        device: "X",
        section: "absolute_maximum",
        items: [
          {
            parameter: "Input voltage",
            value: { min: 20, max: 5, unit: "V" },
            provenance: prov,
            confidence: "high",
          },
        ],
      },
    });
    const result = await validateExtraction({ file });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("min_typ_max_order");
  });
});

describe("validateExtraction — pins", () => {
  test("clean pin table validates ok", async () => {
    const file = await writeExtraction("pins.json", {
      schema_version: 1,
      facet: "pins",
      device: "X",
      payload: {
        device: "X",
        package: "SOT-23-5",
        pin_count: 5,
        pins: [1, 2, 3, 4, 5].map((n) => ({
          number: String(n),
          name: `P${n}`,
          type: "input",
          provenance: prov,
        })),
      },
    });
    const result = await validateExtraction({ file });
    expect(result.ok).toBe(true);
    expect(result.facet).toBe("pins");
    expect(result.stats.pins).toBe(5);
  });

  test("count mismatch fails", async () => {
    const file = await writeExtraction("pins.json", {
      schema_version: 1,
      facet: "pins",
      device: "X",
      payload: {
        device: "X",
        package: "SOT-23-5",
        pin_count: 5,
        pins: [
          { number: "1", name: "A", type: "input", provenance: prov },
          { number: "2", name: "B", type: "input", provenance: prov },
        ],
      },
    });
    const result = await validateExtraction({ file });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("pin_count_mismatch");
  });
});

describe("validateExtraction — circuit", () => {
  test("clean circuit derives nets and validates ok", async () => {
    const file = await writeExtraction("circuit.json", {
      schema_version: 1,
      facet: "circuit",
      device: "X",
      payload: {
        device: "X",
        title: "Typical Application",
        provenance: { page: 3, label: "Figure 2" },
        rails: ["VIN", "GND"],
        confidence: "high",
        components: [
          {
            designator: "U1",
            kind: "ic",
            pins: [
              { pin: "1", connects_to: ["VIN", "C1.1"] },
              { pin: "2", connects_to: ["GND", "C1.2"] },
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
        ],
      },
    });
    const result = await validateExtraction({ file });
    expect(result.ok).toBe(true);
    expect(result.facet).toBe("circuit");
    expect(result.stats.components).toBe(2);
    expect(result.nets?.map((n) => n.name).sort()).toEqual(["GND", "VIN"]);
  });

  test("undeclared component fails", async () => {
    const file = await writeExtraction("circuit.json", {
      schema_version: 1,
      facet: "circuit",
      device: "X",
      payload: {
        device: "X",
        title: "t",
        provenance: { page: 3, label: "Figure 2" },
        rails: ["VIN"],
        confidence: "high",
        components: [
          {
            designator: "U1",
            kind: "ic",
            pins: [{ pin: "1", connects_to: ["VIN", "Q9.G"] }],
          },
        ],
      },
    });
    const result = await validateExtraction({ file });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("undeclared_component");
  });
});

describe("validateExtraction — errors", () => {
  test("throws on missing file", async () => {
    await expect(
      validateExtraction({ file: join(testDir, "does-not-exist.json") }),
    ).rejects.toThrow("Cannot read");
  });

  test("throws on malformed JSON", async () => {
    const file = join(testDir, "bad.json");
    await writeFile(file, "{ not valid json ", "utf-8");
    await expect(validateExtraction({ file })).rejects.toThrow("not valid JSON");
  });

  test("schema violation returns errors with code schema", async () => {
    const file = await writeExtraction("bad-schema.json", {
      schema_version: 1,
      facet: "specs",
      device: "X",
      payload: { device: "X" }, // missing section + items
    });
    const result = await validateExtraction({ file });
    expect(result.ok).toBe(false);
    expect(result.errors.every((e) => e.code === "schema")).toBe(true);
    expect(result.facet).toBe("specs");
  });

  test("unknown facet still reports schema errors", async () => {
    const file = await writeExtraction("bad-facet.json", {
      schema_version: 1,
      facet: "nonsense",
      device: "X",
      payload: {},
    });
    const result = await validateExtraction({ file });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
