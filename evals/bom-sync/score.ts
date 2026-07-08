/**
 * Scorer for the BOM-sync matching suite.
 *
 * Compares a predicted schematic↔BOM correspondence (from the pure
 * `matchSchematicToBom` in src/commands/bom/sync.ts) against a hand-authored
 * golden correspondence. Deterministic, no LLM, no network.
 *
 * Metrics (design-docs/datasheet_understanding_evals.md §8 "bom sync matching"):
 *  - precision / recall / F1 over (ref → bom_entry) matched pairs
 *  - exactness (Jaccard + boolean) of each unmatched set: schematic refs with no
 *    BOM entry, footprint-mismatched refs, orphaned BOM entries, ambiguous refs
 *
 * Headline = mean of pair-F1 and the four set Jaccards. `exact` is the strict
 * gate: every pair and every set reproduced exactly.
 */

import { z } from "zod";
import type { SchBomMatch } from "../../src/commands/bom/sync.js";
import { jaccard, setsEqual } from "../src/shared/gate.js";

export const GoldenMatch = z.object({
  /** schematic ref → expected BOM entry id (clean, footprint-consistent matches). */
  refToEntry: z.record(z.string(), z.string()),
  unmatchedSchRefs: z.array(z.string()).default([]),
  footprintMismatches: z.array(z.string()).default([]),
  ambiguousRefs: z.array(z.string()).default([]),
  orphanedEntryIds: z.array(z.string()).default([]),
});
export type GoldenMatch = z.infer<typeof GoldenMatch>;

export interface BomSyncScore {
  headline: number;
  exact: boolean;
  pair: { precision: number; recall: number; f1: number; matched: number; golden: number };
  sets: {
    unmatchedSchRefs: { jaccard: number; exact: boolean };
    footprintMismatches: { jaccard: number; exact: boolean };
    ambiguousRefs: { jaccard: number; exact: boolean };
    orphanedEntryIds: { jaccard: number; exact: boolean };
  };
}

function pairSet(refToEntry: Record<string, string>): Set<string> {
  return new Set(Object.entries(refToEntry).map(([ref, id]) => `${ref}=>${id}`));
}

function scoreSet(gold: string[], pred: string[]): { jaccard: number; exact: boolean } {
  const g = new Set(gold);
  const p = new Set(pred);
  return { jaccard: jaccard(g, p), exact: setsEqual(g, p) };
}

export function scoreBomSync(golden: GoldenMatch, predicted: SchBomMatch): BomSyncScore {
  const goldPairs = pairSet(golden.refToEntry);
  const predPairs = pairSet(predicted.refToEntry);
  let inter = 0;
  for (const x of predPairs) if (goldPairs.has(x)) inter++;
  const precision = predPairs.size === 0 ? 1 : inter / predPairs.size;
  const recall = goldPairs.size === 0 ? 1 : inter / goldPairs.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const sets = {
    unmatchedSchRefs: scoreSet(golden.unmatchedSchRefs, predicted.unmatchedSchRefs),
    footprintMismatches: scoreSet(golden.footprintMismatches, predicted.footprintMismatches),
    ambiguousRefs: scoreSet(golden.ambiguousRefs, predicted.ambiguousRefs),
    orphanedEntryIds: scoreSet(golden.orphanedEntryIds, predicted.orphanedEntryIds),
  };

  const headline =
    (f1 +
      sets.unmatchedSchRefs.jaccard +
      sets.footprintMismatches.jaccard +
      sets.ambiguousRefs.jaccard +
      sets.orphanedEntryIds.jaccard) /
    5;

  const exact =
    setsEqual(goldPairs, predPairs) &&
    sets.unmatchedSchRefs.exact &&
    sets.footprintMismatches.exact &&
    sets.ambiguousRefs.exact &&
    sets.orphanedEntryIds.exact;

  return {
    headline,
    exact,
    pair: { precision, recall, f1, matched: inter, golden: goldPairs.size },
    sets,
  };
}
