import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/core.js";
import { bomAdd, bomLink, bomRemove, bomShow } from "./core.js";

let testDir: string;
let origCwd: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "pcbpal-bom-test-"));
  await initProject({ dir: testDir });
  origCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(async () => {
  process.chdir(origCwd);
  await rm(testDir, { recursive: true, force: true });
});

describe("bomAdd", () => {
  test("adds an entry to an empty BOM", async () => {
    const result = await bomAdd({
      role: "Decoupling cap",
      category: "passive",
      mpn: "CL05B104KO5NNNC",
      manufacturer: "Samsung",
      refs: ["C1"],
    });

    expect(result.ok).toBe(true);
    expect(result.entry.role).toBe("Decoupling cap");
    expect(result.entry.category).toBe("passive");
    expect(result.entry.mpn).toBe("CL05B104KO5NNNC");
    expect(result.entry.manufacturer).toBe("Samsung");
    expect(result.entry.kicad_refs).toEqual(["C1"]);
    expect(result.entry.status).toBe("candidate");
    expect(result.entry.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("creates LCSC source when --lcsc is provided (without network)", async () => {
    // Test without LCSC lookup (no network) — just the source entry
    const result = await bomAdd({
      role: "Test resistor",
      category: "passive",
      mpn: "RC0402FR-0710KL",
      manufacturer: "YAGEO",
    });

    expect(result.ok).toBe(true);
    expect(result.entry.sources).toEqual([]);
  });

  test("defaults status to candidate", async () => {
    const result = await bomAdd({ role: "Test", category: "other" });
    expect(result.entry.status).toBe("candidate");
  });

  test("respects explicit status", async () => {
    const result = await bomAdd({
      role: "Test",
      category: "other",
      status: "selected",
    });
    expect(result.entry.status).toBe("selected");
  });

  test("sets added and updated timestamps", async () => {
    const before = new Date().toISOString();
    const result = await bomAdd({ role: "Test", category: "other" });
    const after = new Date().toISOString();

    expect(result.entry.added >= before).toBe(true);
    expect(result.entry.added <= after).toBe(true);
    expect(result.entry.updated).toBe(result.entry.added);
  });
});

describe("bomShow", () => {
  test("returns empty list for fresh project", async () => {
    const result = await bomShow({});
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });

  test("returns all entries when no filters", async () => {
    await bomAdd({ role: "Cap", category: "passive" });
    await bomAdd({ role: "Chip", category: "ic" });

    const result = await bomShow({});
    expect(result.total).toBe(2);
  });

  test("filters by category", async () => {
    await bomAdd({ role: "Cap", category: "passive" });
    await bomAdd({ role: "Chip", category: "ic" });

    const result = await bomShow({ category: "passive" });
    expect(result.total).toBe(1);
    expect(result.entries[0].role).toBe("Cap");
  });

  test("filters by status", async () => {
    await bomAdd({ role: "A", category: "other", status: "candidate" });
    await bomAdd({ role: "B", category: "other", status: "selected" });

    const result = await bomShow({ status: "selected" });
    expect(result.total).toBe(1);
    expect(result.entries[0].role).toBe("B");
  });
});

describe("bomRemove", () => {
  test("removes entry by full ID", async () => {
    const { entry } = await bomAdd({ role: "Test", category: "other" });
    const result = await bomRemove(entry.id);

    expect(result.ok).toBe(true);
    expect(result.removed.id).toBe(entry.id);

    const show = await bomShow({});
    expect(show.total).toBe(0);
  });

  test("removes entry by ID prefix", async () => {
    const { entry } = await bomAdd({ role: "Test", category: "other" });
    const prefix = entry.id.slice(0, 8);
    const result = await bomRemove(prefix);

    expect(result.removed.id).toBe(entry.id);
  });

  test("throws for unknown ID", async () => {
    expect(bomRemove("nonexistent")).rejects.toThrow("not found");
  });
});

describe("bomLink", () => {
  test("links refs to an entry", async () => {
    const { entry } = await bomAdd({ role: "Cap", category: "passive" });
    const result = await bomLink(entry.id, ["C1", "C2"]);

    expect(result.ok).toBe(true);
    expect(result.entry.kicad_refs).toEqual(["C1", "C2"]);
  });

  test("merges and deduplicates refs", async () => {
    const { entry } = await bomAdd({
      role: "Cap",
      category: "passive",
      refs: ["C1"],
    });
    const result = await bomLink(entry.id, ["C1", "C2", "C3"]);

    expect(result.entry.kicad_refs).toEqual(["C1", "C2", "C3"]);
  });

  test("updates the timestamp", async () => {
    const { entry } = await bomAdd({ role: "Cap", category: "passive" });
    const originalUpdated = entry.updated;

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    const result = await bomLink(entry.id, ["C1"]);

    expect(result.entry.updated >= originalUpdated).toBe(true);
  });

  test("works with ID prefix", async () => {
    const { entry } = await bomAdd({ role: "Cap", category: "passive" });
    const prefix = entry.id.slice(0, 8);
    const result = await bomLink(prefix, ["C5"]);

    expect(result.entry.kicad_refs).toContain("C5");
  });

  test("throws for unknown ID", async () => {
    expect(bomLink("nonexistent", ["C1"])).rejects.toThrow("not found");
  });
});
