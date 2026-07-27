import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runFixture } from "./run.js";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("bom-sync fixtures via matchSchematicToBom", () => {
  test("clean-1to1 (.kicad_sch route) scores exact", async () => {
    const r = await runFixture(join(FIXTURES, "clean-1to1"));
    expect(r.score.exact).toBe(true);
    expect(r.predicted.refToEntry.R1).toBe("aaaaaaaa-0001-0001-0001-000000000001");
    // Proves the shipped readSchematicComponents parser handled the fixture.
    expect(Object.keys(r.predicted.refToEntry).length).toBe(3);
  });

  test("multi-ref folds R3/R4 into the entry that listed only R1/R2", async () => {
    const r = await runFixture(join(FIXTURES, "multi-ref"));
    expect(r.score.exact).toBe(true);
    expect(r.predicted.refToEntry.R4).toBe("aaaaaaaa-0002-0002-0002-000000000002");
  });

  test("missing-in-bom (components.json route) flags D1 unmatched", async () => {
    const r = await runFixture(join(FIXTURES, "missing-in-bom"));
    expect(r.score.exact).toBe(true);
    expect(r.predicted.unmatchedSchRefs).toEqual(["D1"]);
  });

  test("orphan-bom flags the removed U9 entry", async () => {
    const r = await runFixture(join(FIXTURES, "orphan-bom"));
    expect(r.score.exact).toBe(true);
    expect(r.predicted.orphanedEntryIds).toEqual(["cccccccc-0004-0004-0004-000000000004"]);
  });

  test("fp-mismatch does NOT clean-match C5; it is flagged", async () => {
    const r = await runFixture(join(FIXTURES, "fp-mismatch"));
    expect(r.score.exact).toBe(true);
    expect(r.predicted.refToEntry.C5).toBeUndefined();
    expect(r.predicted.footprintMismatches).toEqual(["C5"]);
  });
});
