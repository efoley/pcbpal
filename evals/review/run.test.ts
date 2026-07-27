import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BomDatabase } from "../../src/schemas/bom.js";
import { buildContext, runFixture } from "./run.js";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("buildContext", () => {
  test("parses the fixture netlist XML and folds in BOM roles", async () => {
    const dir = join(FIXTURES, "missing-decoupling");
    const bom = BomDatabase.parse(JSON.parse(await readFile(join(dir, "bom.json"), "utf-8")));
    const xml = await readFile(join(dir, "netlist.xml"), "utf-8");
    const ctx = buildContext(xml, bom);
    // parseNetlistXml found the components and nets.
    expect(ctx).toContain("U1: AMS1117-3.3");
    expect(ctx).toContain("+3V3:");
    expect(ctx).toContain("AMS1117-3.3 LDO regulator");
  });
});

describe("review fixtures (dry-run)", () => {
  test("missing-decoupling synthesized review satisfies its criteria", async () => {
    const r = await runFixture(join(FIXTURES, "missing-decoupling"), false);
    expect(r.score.allFound).toBe(true);
  });

  test("swapped-feedback synthesized review satisfies its criteria", async () => {
    const r = await runFixture(join(FIXTURES, "swapped-feedback"), false);
    expect(r.score.allFound).toBe(true);
  });
});
