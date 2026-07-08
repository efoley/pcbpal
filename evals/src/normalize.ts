/**
 * Normalization + fuzzy matching for spec/pin scoring.
 *
 * Reuses pcbpal's own unit machinery (src/util/units.ts) so the harness and the
 * shipped `datasheet validate` agree on what "the same value" means.
 */

import type { SpecValue } from "../../src/schemas/datasheet.js";
import { normalizeUnit, parseQuantity, unitClassOf } from "../../src/util/units.js";

/** Lowercase, collapse whitespace, strip surrounding punctuation. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .replace(/[()]/g, "")
    .trim();
}

/** Alphanumeric-only fold, for symbol keys and fuzzy comparison. */
export function foldName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The match key for a spec item. A printed symbol (VIN, IQ) is a far stronger
 * identity than the free-text parameter name, so when present it wins; the
 * `symbol:` / `param:` prefix keeps the two namespaces from colliding.
 */
export function specKey(item: { parameter: string; symbol?: string }): string {
  if (item.symbol && item.symbol.trim() !== "") return `symbol:${foldName(item.symbol)}`;
  return `param:${foldName(item.parameter)}`;
}

/**
 * Fuzzy parameter-name match: exact after folding, or one folded name contains
 * the other (handles "Input voltage" vs "Input voltage range"). Empty names
 * never match.
 */
export function fuzzyNameMatch(a: string, b: string): boolean {
  const na = foldName(a);
  const nb = foldName(b);
  if (na === "" || nb === "") return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

const DEFAULT_TOLERANCE = 0.02;

/** Relative difference of two numbers expressed with the same unit string. */
function fieldWithinTolerance(
  golden: number,
  candidate: number,
  unitGolden: string,
  unitCandidate: string,
  tolerance: number,
): boolean {
  const qg = parseQuantity(`${golden}${unitGolden}`);
  const qc = parseQuantity(`${candidate}${unitCandidate}`);
  if (!qg || !qc) {
    // Unit unparseable on one side: fall back to a raw relative comparison,
    // still requiring the normalized units to match.
    if (normalizeUnit(unitGolden) !== normalizeUnit(unitCandidate)) return false;
    const denom = Math.max(Math.abs(golden), Math.abs(candidate));
    if (denom === 0) return true;
    return Math.abs(golden - candidate) / denom <= tolerance;
  }
  if (qg.unit !== qc.unit) return false; // different base unit → different value
  const denom = Math.max(Math.abs(qg.value), Math.abs(qc.value));
  if (denom === 0) return true;
  return Math.abs(qg.value - qc.value) / denom <= tolerance;
}

/**
 * Whether an extracted SpecValue faithfully reproduces the golden one.
 *
 * Rules:
 *  - unit class must agree (a voltage reported in amps is always wrong);
 *  - for each of min/typ/max: presence must agree (a fabricated max where the
 *    golden has none counts as disagreement — that is exactly the "invented
 *    plausible bound" failure the eval punishes), and where both are present
 *    the values must be within `tolerance` after unit normalization.
 */
export function specValuesAgree(
  golden: SpecValue,
  candidate: SpecValue,
  tolerance: number = DEFAULT_TOLERANCE,
): boolean {
  const cg = unitClassOf(golden.unit);
  const cc = unitClassOf(candidate.unit);
  // If both units classify to a known physical class they must match; "other"
  // (unrecognized) units fall through to the per-field string/number compare.
  if (cg !== "other" && cc !== "other" && cg !== cc) return false;

  for (const field of ["min", "typ", "max"] as const) {
    const gv = golden[field];
    const cv = candidate[field];
    const gPresent = gv !== undefined;
    const cPresent = cv !== undefined;
    if (gPresent !== cPresent) return false;
    if (gPresent && cPresent) {
      if (!fieldWithinTolerance(gv, cv, golden.unit, candidate.unit, tolerance)) return false;
    }
  }
  return true;
}
