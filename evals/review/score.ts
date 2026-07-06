/**
 * Scorer for the seeded-defect review suite.
 *
 * Each fixture seeds one defect (a missing decoupling cap, a swapped feedback
 * divider, …) into a synthetic netlist + BOM. The golden lists "the review
 * should mention" criteria as regexes. The scorer takes a review text (from the
 * runner's dry-run synthesis or a live model call) and reports which criteria
 * were found and which were missed.
 *
 * Metric: recall over the criteria (headline). `allFound` is the strict gate —
 * a review that misses any seeded-defect criterion has not caught the defect.
 */

import { z } from "zod";
import { compileRegex } from "../search/score.js";

export const ReviewCriterion = z.object({
  id: z.string(),
  regex: z.string(),
  why: z.string(),
  /** Literal phrase matching `regex`, used only to synthesize the dry-run review. */
  sample: z.string(),
});
export type ReviewCriterion = z.infer<typeof ReviewCriterion>;

export const ReviewGolden = z.object({
  id: z.string(),
  defect: z.string(),
  target: z.string(), // e.g. "schematic"
  mustMention: z.array(ReviewCriterion),
});
export type ReviewGolden = z.infer<typeof ReviewGolden>;

export interface ReviewScore {
  headline: number; // = recall
  allFound: boolean;
  found: string[]; // criterion ids matched
  missed: string[]; // criterion ids not matched
}

export function scoreReview(golden: ReviewGolden, reviewText: string): ReviewScore {
  const found: string[] = [];
  const missed: string[] = [];
  for (const c of golden.mustMention) {
    if (compileRegex(c.regex).test(reviewText)) found.push(c.id);
    else missed.push(c.id);
  }
  const total = golden.mustMention.length;
  const recall = total === 0 ? 1 : found.length / total;
  return { headline: recall, allFound: missed.length === 0, found, missed };
}

/** Synthesize a review that satisfies every criterion — the dry-run plumbing check. */
export function synthesizeReview(golden: ReviewGolden): string {
  const lines = [`Review of ${golden.target}:`, golden.defect];
  for (const c of golden.mustMention) lines.push(`- ${c.why}: ${c.sample}`);
  return lines.join("\n");
}
