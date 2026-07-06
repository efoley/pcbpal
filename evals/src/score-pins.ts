/**
 * Field-level scoring for the `pins` facet. Pins are matched by pin number
 * (the physical identity), then name (case-insensitive) and type are compared
 * over the matched set. See design-docs/datasheet_understanding_evals.md §6.
 */

import type { PinTable } from "../../src/schemas/datasheet.js";
import type { CaseScore } from "./types.js";

export interface PinScoreDetail {
  golden_n: number;
  extracted_n: number;
  matched: number; // matched by pin number
  coverage: number; // matched / golden_n
  exact: number; // matched AND name+type both correct
  name_accuracy: number; // over matched-by-number
  type_accuracy: number; // over matched-by-number
  extra_pins: string[]; // candidate pin numbers absent from golden
  missing_pins: string[]; // golden pin numbers absent from candidate
  headline: number;
  hallucination_rate: number;
}

function normNumber(n: string): string {
  return n.trim().toLowerCase();
}

export function scorePins(golden: PinTable, candidate: PinTable): CaseScore {
  const goldenByNumber = new Map(golden.pins.map((p) => [normNumber(p.number), p]));
  const candByNumber = new Map(candidate.pins.map((p) => [normNumber(p.number), p]));

  const goldenN = golden.pins.length;
  const extractedN = candidate.pins.length;

  let matched = 0;
  let nameCorrect = 0;
  let typeCorrect = 0;
  let exact = 0;
  const missing: string[] = [];

  for (const [num, g] of goldenByNumber) {
    const c = candByNumber.get(num);
    if (!c) {
      missing.push(g.number);
      continue;
    }
    matched++;
    const nameOk = g.name.trim().toLowerCase() === c.name.trim().toLowerCase();
    const typeOk = g.type === c.type;
    if (nameOk) nameCorrect++;
    if (typeOk) typeCorrect++;
    if (nameOk && typeOk) exact++;
  }

  const extra: string[] = [];
  for (const [num, c] of candByNumber) {
    if (!goldenByNumber.has(num)) extra.push(c.number);
  }

  const coverage = goldenN === 0 ? 1 : matched / goldenN;
  const nameAccuracy = matched === 0 ? 1 : nameCorrect / matched;
  const typeAccuracy = matched === 0 ? 1 : typeCorrect / matched;
  // Headline: fraction of golden pins reproduced exactly (number+name+type).
  const headline = goldenN === 0 ? (extractedN === 0 ? 1 : 0) : exact / goldenN;
  // Hallucination for pins = invented pin numbers relative to what was reported.
  const hallucinationRate = extractedN === 0 ? 0 : extra.length / extractedN;

  const detail: PinScoreDetail = {
    golden_n: goldenN,
    extracted_n: extractedN,
    matched,
    coverage,
    exact,
    name_accuracy: nameAccuracy,
    type_accuracy: typeAccuracy,
    extra_pins: extra.sort(),
    missing_pins: missing.sort(),
    headline,
    hallucination_rate: hallucinationRate,
  };

  return {
    headline,
    hallucination_rate: hallucinationRate,
    topologyPass: null,
    detail: detail as unknown as Record<string, unknown>,
  };
}
