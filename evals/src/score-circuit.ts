/**
 * Graph-level scoring for the `circuit` facet. Thin adapter over the shipped
 * circuit referee (src/services/refcircuit-compare.ts) — the harness does NOT
 * reimplement component matching or connectivity comparison, it reuses the same
 * code `datasheet diff` uses so eval scores and production diffs never diverge.
 */

import type { ReferenceCircuit } from "../../src/schemas/datasheet.js";
import { compareCircuits, fromReferenceCircuit } from "../../src/services/refcircuit-compare.js";
import type { CaseScore } from "./types.js";

export interface CircuitScoreDetail {
  componentRecall: number;
  componentPrecision: number;
  valueAccuracy: number;
  connectionF1: number;
  netExactness: number;
  topologyPass: boolean;
  hallucinated_components: number; // candidate components with no golden match
  missed_components: number; // golden components with no candidate match
  hallucinated_ids: string[];
  missed_ids: string[];
  headline: number;
  hallucination_rate: number;
}

export function scoreCircuit(golden: ReferenceCircuit, candidate: ReferenceCircuit): CaseScore {
  const g = fromReferenceCircuit(golden);
  const c = fromReferenceCircuit(candidate);
  const cmp = compareCircuits(g, c);
  const m = cmp.metrics;

  const hallucinated = cmp.unmatchedCandidate.length;
  const missed = cmp.unmatchedGolden.length;
  const candidateN = c.components.length;

  // Headline = connectivity F1 (the metric that most directly reflects "can we
  // trust the extracted topology"); topologyPass is surfaced separately.
  const headline = m.connectionF1;
  const hallucinationRate = candidateN === 0 ? 0 : hallucinated / candidateN;

  const detail: CircuitScoreDetail = {
    componentRecall: m.componentRecall,
    componentPrecision: m.componentPrecision,
    valueAccuracy: m.valueAccuracy,
    connectionF1: m.connectionF1,
    netExactness: m.netExactness,
    topologyPass: m.topologyPass,
    hallucinated_components: hallucinated,
    missed_components: missed,
    hallucinated_ids: cmp.unmatchedCandidate,
    missed_ids: cmp.unmatchedGolden,
    headline,
    hallucination_rate: hallucinationRate,
  };

  return {
    headline,
    hallucination_rate: hallucinationRate,
    topologyPass: m.topologyPass,
    detail: detail as unknown as Record<string, unknown>,
  };
}
