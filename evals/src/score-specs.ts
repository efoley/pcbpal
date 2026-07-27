/**
 * Field-level scoring for the `specs` facet.
 *
 * Golden and extracted spec items are matched by normalized (symbol|parameter)
 * key with a fuzzy parameter fallback, then compared value-by-value. Metrics
 * follow design-docs/datasheet_understanding_evals.md §6 "Metrics".
 */

import type { SpecItem, SpecTable } from "../../src/schemas/datasheet.js";
import { fuzzyNameMatch, specKey, specValuesAgree } from "./normalize.js";
import type { CaseScore } from "./types.js";

interface Confidence {
  n: number;
  correct: number;
}

export interface SpecScoreDetail {
  golden_n: number;
  extracted_n: number;
  matched: number;
  recall: number;
  precision: number;
  omission_rate: number;
  value_wrong: number;
  provenance_wrong: number;
  invented: number; // extracted items with no golden counterpart
  hallucination_rate: number;
  provenance_accuracy: number;
  headline: number;
  calibration: { high: Confidence; medium: Confidence; low: Confidence };
}

interface Match {
  golden: SpecItem;
  candidate: SpecItem;
}

/**
 * Greedy matching: for each golden item, prefer an exact symbol-key hit among
 * still-unmatched candidates, else the first fuzzy parameter-name match. Symbol
 * identity outranks parameter fuzz, so symbol matching runs as a first pass.
 */
function matchItems(
  golden: SpecItem[],
  candidate: SpecItem[],
): {
  matches: Match[];
  unmatchedGolden: SpecItem[];
  unmatchedCandidate: SpecItem[];
} {
  const usedCandidate = new Set<number>();
  const matches: Match[] = [];
  const matchedGolden = new Set<number>();

  // Pass 1: exact key (symbol wins, else folded parameter).
  golden.forEach((g, gi) => {
    const key = specKey(g);
    const ci = candidate.findIndex((c, i) => !usedCandidate.has(i) && specKey(c) === key);
    if (ci >= 0) {
      usedCandidate.add(ci);
      matchedGolden.add(gi);
      matches.push({ golden: g, candidate: candidate[ci] });
    }
  });

  // Pass 2: fuzzy parameter-name fallback for still-unmatched golden items.
  golden.forEach((g, gi) => {
    if (matchedGolden.has(gi)) return;
    const ci = candidate.findIndex(
      (c, i) => !usedCandidate.has(i) && fuzzyNameMatch(g.parameter, c.parameter),
    );
    if (ci >= 0) {
      usedCandidate.add(ci);
      matchedGolden.add(gi);
      matches.push({ golden: g, candidate: candidate[ci] });
    }
  });

  const unmatchedGolden = golden.filter((_, gi) => !matchedGolden.has(gi));
  const unmatchedCandidate = candidate.filter((_, i) => !usedCandidate.has(i));
  return { matches, unmatchedGolden, unmatchedCandidate };
}

function emptyConfidence(): Confidence {
  return { n: 0, correct: 0 };
}

/**
 * Score an extracted spec table against a golden one.
 *
 * Headline formula (documented per the design spec): a hallucinated fact is
 * weighted 4× an omission because a fabricated-but-plausible value is the worst
 * outcome. With `H` = hallucinations (wrong-value matched items + invented
 * items), `O` = omissions (unmatched golden items), and `N` = golden item count:
 *
 *     weighted_error = (4*H + O) / (5*N)
 *     headline       = clamp(1 - weighted_error, 0, 1)
 *
 * (denominator 5*N = 4*N + N, the max weighted error if every golden item were
 * both hallucinated and omitted — a loose upper bound that keeps the score in
 * range.)
 */
export function scoreSpecs(golden: SpecTable, candidate: SpecTable): CaseScore {
  const { matches, unmatchedGolden, unmatchedCandidate } = matchItems(
    golden.items,
    candidate.items,
  );

  const goldenN = golden.items.length;
  const extractedN = candidate.items.length;
  const matched = matches.length;
  const invented = unmatchedCandidate.length;

  let valueWrong = 0;
  let provenanceWrong = 0;
  let provenanceComparable = 0;
  let provenanceCorrect = 0;

  const calibration = {
    high: emptyConfidence(),
    medium: emptyConfidence(),
    low: emptyConfidence(),
  };

  for (const m of matches) {
    const valueOk = specValuesAgree(m.golden.value, m.candidate.value);
    if (!valueOk) valueWrong++;

    // Provenance is checkable only when both cite a page (golden always does).
    provenanceComparable++;
    const provOk = m.candidate.provenance.page === m.golden.provenance.page;
    if (provOk) provenanceCorrect++;
    else provenanceWrong++;

    const bucket = calibration[m.candidate.confidence];
    bucket.n++;
    if (valueOk && provOk) bucket.correct++;
  }

  // Invented items count against calibration of whatever confidence they claim.
  for (const c of unmatchedCandidate) {
    calibration[c.confidence].n++;
  }

  // A matched item is "hallucinated" if its value is wrong OR it cites the
  // wrong page; invented items are hallucinated by definition.
  let hallucinatedMatched = 0;
  for (const m of matches) {
    const valueOk = specValuesAgree(m.golden.value, m.candidate.value);
    const provOk = m.candidate.provenance.page === m.golden.provenance.page;
    if (!valueOk || !provOk) hallucinatedMatched++;
  }
  const hallucinations = hallucinatedMatched + invented;
  const omissions = unmatchedGolden.length;

  const recall = goldenN === 0 ? 1 : matched / goldenN;
  const precision = extractedN === 0 ? 1 : matched / extractedN;
  const omissionRate = goldenN === 0 ? 0 : omissions / goldenN;
  const hallucinationRate = extractedN === 0 ? 0 : hallucinations / extractedN;
  const provenanceAccuracy =
    provenanceComparable === 0 ? 1 : provenanceCorrect / provenanceComparable;

  let headline: number;
  if (goldenN === 0) {
    headline = invented > 0 ? 0 : 1;
  } else {
    const weightedError = (4 * hallucinations + omissions) / (5 * goldenN);
    headline = Math.max(0, Math.min(1, 1 - weightedError));
  }

  const detail: SpecScoreDetail = {
    golden_n: goldenN,
    extracted_n: extractedN,
    matched,
    recall,
    precision,
    omission_rate: omissionRate,
    value_wrong: valueWrong,
    provenance_wrong: provenanceWrong,
    invented,
    hallucination_rate: hallucinationRate,
    provenance_accuracy: provenanceAccuracy,
    headline,
    calibration,
  };

  return {
    headline,
    hallucination_rate: hallucinationRate,
    topologyPass: null,
    detail: detail as unknown as Record<string, unknown>,
  };
}
