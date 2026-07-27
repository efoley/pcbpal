/**
 * Zod schemas + TypeScript types for the datasheet-extraction eval harness.
 *
 * See design-docs/datasheet_understanding_evals.md §6. Everything that is
 * persisted (manifest, golden files, run reports, baseline) has a Zod schema
 * here so the harness validates its own inputs and outputs the same way pcbpal
 * core validates BOM/production files.
 */

import { z } from "zod";
import {
  DatasheetExtraction,
  type PinTable,
  type ReferenceCircuit,
  type SpecTable,
} from "../../src/schemas/datasheet.js";

// ── Facet / strategy / model ──

export const Facet = z.enum(["specs", "pins", "circuit"]);
export type Facet = z.infer<typeof Facet>;

export const Strategy = z.enum(["single-pass", "validate-retry", "verifier", "self-consistency-3"]);
export type Strategy = z.infer<typeof Strategy>;

/** A model to run against. `id` is passed verbatim to the Anthropic API. */
export const ModelSpec = z.object({
  id: z.string(),
  maxTokens: z.number().int().positive().default(8192),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

// ── Manifest (evals/datasheets/manifest.json) ──

export const ManifestPart = z.object({
  id: z.string(), // stable part id, also the golden directory name
  mpn: z.string(),
  lcsc: z.string().optional(),
  pdf_url: z.string(),
  pdf_sha256: z.string(), // "TBD" allowed until the PDF is first fetched
  facets: z.array(Facet),
  // For the circuit facet a part may have several application figures; each
  // gets its own golden file `circuit-<label>.json` and its own eval case.
  circuit_labels: z.array(z.string()).default(["typical"]),
  // Optional per-facet page hints ("specs": [4,5], "circuit-typical": [12]).
  // Used by the runner when a PDF is present and pages aren't auto-detected.
  pages: z.record(z.string(), z.array(z.number().int().positive())).optional(),
});
export type ManifestPart = z.infer<typeof ManifestPart>;

export const Manifest = z.object({
  parts: z.array(ManifestPart),
});
export type Manifest = z.infer<typeof Manifest>;

// ── Golden files (evals/datasheets/golden/<part>/<facet>.json) ──

export const GoldenFile = z.object({
  golden_version: z.literal(1),
  // MUST be false for anything an agent authored: humans verify goldens.
  verified: z.boolean(),
  verified_by: z.string().nullable(),
  notes: z.string(),
  extraction: DatasheetExtraction,
});
export type GoldenFile = z.infer<typeof GoldenFile>;

// ── Expanded eval case (one golden file × one strategy × one model) ──

export interface EvalCase {
  partId: string;
  mpn: string;
  lcsc?: string;
  facet: Facet;
  label?: string; // circuit figure label, when facet === "circuit"
  goldenPath: string;
  pdfUrl: string;
  pdfSha256: string;
  pages?: number[];
}

// ── Scores ──

/**
 * Uniform per-case score. Every facet reports the same three headline fields
 * so report/baseline logic is facet-agnostic; `detail` carries the
 * facet-specific breakdown (recall/precision/calibration/etc.).
 */
export const CaseScore = z.object({
  headline: z.number(), // [0,1], higher is better
  hallucination_rate: z.number(), // [0,1], lower is better
  topologyPass: z.boolean().nullable(), // circuits only, else null
  detail: z.record(z.string(), z.unknown()),
});
export type CaseScore = z.infer<typeof CaseScore>;

export const CaseResult = z.object({
  partId: z.string(),
  mpn: z.string(),
  facet: Facet,
  label: z.string().optional(),
  strategy: Strategy,
  model: z.string(),
  skipped: z.boolean(),
  reason: z.string().optional(), // why skipped, or strategy failure reason
  unverifiedGolden: z.boolean(),
  calls: z.number().int().nonnegative(),
  score: CaseScore.nullable(),
});
export type CaseResult = z.infer<typeof CaseResult>;

export const EvalRun = z.object({
  runLabel: z.string(),
  timestamp: z.string(),
  model: z.string(),
  strategy: Strategy,
  dryRun: z.boolean(),
  cases: z.array(CaseResult),
});
export type EvalRun = z.infer<typeof EvalRun>;

// ── Baseline (evals/baseline.json) ──

/** Per-case accepted metrics keyed by `<part>:<facet>[:<label>]:<strategy>:<model>`. */
export const BaselineEntry = z.object({
  headline: z.number(),
  hallucination_rate: z.number(),
  topologyPass: z.boolean().nullable(),
});
export type BaselineEntry = z.infer<typeof BaselineEntry>;

export const Baseline = z.record(z.string(), BaselineEntry);
export type Baseline = z.infer<typeof Baseline>;

/** Stable key identifying an eval case across runs. */
export function caseKey(
  partId: string,
  facet: Facet,
  strategy: Strategy,
  model: string,
  label?: string,
): string {
  const facetPart = label ? `${facet}-${label}` : facet;
  return `${partId}:${facetPart}:${strategy}:${model}`;
}

// Re-export payload types for the scorers.
export type { PinTable, ReferenceCircuit, SpecTable };
