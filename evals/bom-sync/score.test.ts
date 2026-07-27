import { describe, expect, test } from "bun:test";
import type { SchBomMatch } from "../../src/commands/bom/sync.js";
import { type GoldenMatch, scoreBomSync } from "./score.js";

function match(p: Partial<SchBomMatch>): SchBomMatch {
  return {
    refToEntry: {},
    unmatchedSchRefs: [],
    footprintMismatches: [],
    ambiguousRefs: [],
    orphanedEntryIds: [],
    groups: [],
    ...p,
  };
}

function golden(p: Partial<GoldenMatch>): GoldenMatch {
  return {
    refToEntry: {},
    unmatchedSchRefs: [],
    footprintMismatches: [],
    ambiguousRefs: [],
    orphanedEntryIds: [],
    ...p,
  };
}

describe("scoreBomSync", () => {
  test("identical correspondence is perfect and exact", () => {
    const g = golden({ refToEntry: { R1: "e1", C1: "e2" }, unmatchedSchRefs: ["D1"] });
    const p = match({ refToEntry: { R1: "e1", C1: "e2" }, unmatchedSchRefs: ["D1"] });
    const s = scoreBomSync(g, p);
    expect(s.headline).toBe(1);
    expect(s.exact).toBe(true);
    expect(s.pair.f1).toBe(1);
  });

  test("a mismatched pair drops precision and recall", () => {
    const g = golden({ refToEntry: { R1: "e1", R2: "e1" } });
    // R2 mapped to the wrong entry.
    const p = match({ refToEntry: { R1: "e1", R2: "e9" } });
    const s = scoreBomSync(g, p);
    expect(s.pair.matched).toBe(1);
    expect(s.pair.precision).toBeCloseTo(0.5);
    expect(s.pair.recall).toBeCloseTo(0.5);
    expect(s.exact).toBe(false);
    expect(s.headline).toBeLessThan(1);
  });

  test("missing an unmatched-ref (false negative on the unmatched set) is caught", () => {
    const g = golden({ refToEntry: { R1: "e1" }, unmatchedSchRefs: ["D1"] });
    // Predicted misses that D1 is unmatched.
    const p = match({ refToEntry: { R1: "e1" } });
    const s = scoreBomSync(g, p);
    expect(s.sets.unmatchedSchRefs.exact).toBe(false);
    expect(s.sets.unmatchedSchRefs.jaccard).toBe(0);
    expect(s.exact).toBe(false);
  });

  test("orphaned-entry set exactness is scored", () => {
    const g = golden({ orphanedEntryIds: ["e9"] });
    const p = match({ orphanedEntryIds: ["e9"] });
    expect(scoreBomSync(g, p).sets.orphanedEntryIds.exact).toBe(true);
    const p2 = match({ orphanedEntryIds: [] });
    expect(scoreBomSync(g, p2).sets.orphanedEntryIds.exact).toBe(false);
  });

  test("footprint mismatch belongs in its own set, not refToEntry", () => {
    const g = golden({ footprintMismatches: ["C5"] });
    // A matcher that silently clean-matched C5 instead of flagging it.
    const p = match({ refToEntry: { C5: "e1" } });
    const s = scoreBomSync(g, p);
    expect(s.sets.footprintMismatches.exact).toBe(false);
    expect(s.pair.precision).toBe(0); // invented a pair the golden doesn't have
    expect(s.exact).toBe(false);
  });
});
