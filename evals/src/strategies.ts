/**
 * Extraction strategies — the "dials" from design-docs/…evals.md §4/§6.4.
 *
 * Each strategy takes a StrategyContext (prompt + page images + transport) and
 * returns a Zod-validated DatasheetExtraction, or a structured failure the
 * scorer counts as a total omission. Multi-call strategies (verifier,
 * self-consistency) layer extra model calls on top of the single-pass floor.
 *
 * The deterministic validate dispatch reuses the pure checks exported from
 * src/services/refcircuit.ts directly (validateSpecTable / validatePinTable /
 * deriveNets) rather than `datasheet validate`'s core, because that core does
 * file I/O; the checks themselves are pure and importable.
 */

import { z } from "zod";
import type { DatasheetExtraction, ReferenceCircuit } from "../../src/schemas/datasheet.js";
import { DatasheetExtraction as DatasheetExtractionSchema } from "../../src/schemas/datasheet.js";
import {
  deriveNets,
  type Finding,
  validatePinTable,
  validateSpecTable,
} from "../../src/services/refcircuit.js";
import type { ContentBlock, ModelMessage, ModelTransport } from "./transport.js";
import type { Facet, ModelSpec } from "./types.js";

const SYSTEM =
  "You are a meticulous datasheet extraction agent. Emit only the requested JSON object, " +
  "matching the provided schema exactly. Never invent values; cite provenance for every fact.";

export interface StrategyContext {
  part: { id: string; mpn: string };
  facet: Facet;
  images: ContentBlock[]; // page PNG blocks; empty in --dry-run
  prompt: string; // instructions from src/commands/datasheet/prompts.ts
  schemaJson: string; // JSON Schema for the facet envelope
  transport: ModelTransport;
  model: ModelSpec;
}

export type StrategyResult =
  | { ok: true; extraction: DatasheetExtraction; calls: number }
  | { ok: false; reason: string; calls: number };

export type StrategyFn = (ctx: StrategyContext) => Promise<StrategyResult>;

// ── JSON extraction / parsing ──

/** Pull a JSON object out of model text (fenced block or first {…last }). */
export function extractJson(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

interface ParseOk {
  ok: true;
  data: DatasheetExtraction;
}
interface ParseErr {
  ok: false;
  error: string;
}

function parseExtraction(text: string, facet: Facet): ParseOk | ParseErr {
  const json = extractJson(text);
  if (json === null) return { ok: false, error: "no JSON object found in response" };
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `JSON parse error: ${(e as Error).message}` };
  }
  const parsed = DatasheetExtractionSchema.safeParse(obj);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  if (parsed.data.facet !== facet) {
    return { ok: false, error: `expected facet "${facet}", got "${parsed.data.facet}"` };
  }
  return { ok: true, data: parsed.data };
}

function userMessage(text: string, images: ContentBlock[]): ModelMessage {
  return { role: "user", content: [{ type: "text", text }, ...images] };
}

function baseMessages(ctx: StrategyContext): ModelMessage[] {
  const text = `${ctx.prompt}\n\n## Output JSON Schema\n\n\`\`\`json\n${ctx.schemaJson}\n\`\`\`\n\nRespond with a single JSON object matching this schema.`;
  return [userMessage(text, ctx.images)];
}

/** One extraction with a single reparse-retry on malformed output. */
async function extractWithRetry(
  ctx: StrategyContext,
  messages: ModelMessage[],
): Promise<StrategyResult & { rawText?: string }> {
  let calls = 0;
  let convo = messages;
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ctx.transport.complete({
      system: SYSTEM,
      messages: convo,
      model: ctx.model.id,
      maxTokens: ctx.model.maxTokens,
      forceJson: true,
    });
    calls++;
    const parsed = parseExtraction(res.text, ctx.facet);
    if (parsed.ok) return { ok: true, extraction: parsed.data, calls, rawText: res.text };
    lastErr = parsed.error;
    convo = [
      ...convo,
      { role: "assistant", content: [{ type: "text", text: res.text }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Your previous output did not parse as a valid ${ctx.facet} extraction: ${lastErr}. Re-emit the corrected JSON object only.`,
          },
        ],
      },
    ];
  }
  return { ok: false, reason: `parse failure after 2 attempts: ${lastErr}`, calls };
}

// ── Deterministic validate dispatch (pure, from refcircuit.ts) ──

function deterministicFindings(ext: DatasheetExtraction): Finding[] {
  if (ext.facet === "specs") return validateSpecTable(ext.payload);
  if (ext.facet === "pins") return validatePinTable(ext.payload);
  return deriveNets(ext.payload).findings;
}

function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `- [${f.code}] ${f.message}`).join("\n");
}

// ── single-pass ──

export const singlePass: StrategyFn = async (ctx) => {
  const res = await extractWithRetry(ctx, baseMessages(ctx));
  if (!res.ok) return { ok: false, reason: res.reason, calls: res.calls };
  return { ok: true, extraction: res.extraction, calls: res.calls };
};

// ── validate-retry (one feedback round of the deterministic checks) ──

export const validateRetry: StrategyFn = async (ctx) => {
  const first = await extractWithRetry(ctx, baseMessages(ctx));
  if (!first.ok) return { ok: false, reason: first.reason, calls: first.calls };

  const errors = deterministicFindings(first.extraction).filter((f) => f.severity === "error");
  if (errors.length === 0) return { ok: true, extraction: first.extraction, calls: first.calls };

  const feedback: ModelMessage[] = [
    ...baseMessages(ctx),
    { role: "assistant", content: [{ type: "text", text: first.rawText ?? "" }] },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `The deterministic validator rejected your output with these ERRORS:\n${formatFindings(errors)}\n\nFix every one and re-emit the corrected JSON object only.`,
        },
      ],
    },
  ];
  const second = await extractWithRetry(ctx, feedback);
  const calls = first.calls + second.calls;
  if (second.ok) return { ok: true, extraction: second.extraction, calls };
  // Retry couldn't produce parseable output — keep the first (it at least parsed).
  return { ok: true, extraction: first.extraction, calls };
};

// ── verifier (skeptical second pass) ──

const Verdicts = z.object({
  verdicts: z.array(
    z.object({
      ref: z.string(),
      verdict: z.enum(["confirmed", "wrong", "not_at_cited_location"]),
    }),
  ),
});

function parseVerdicts(text: string): Map<string, string> {
  const json = extractJson(text);
  const out = new Map<string, string>();
  if (json === null) return out;
  try {
    const parsed = Verdicts.safeParse(JSON.parse(json));
    if (parsed.success) {
      for (const v of parsed.data.verdicts) out.set(v.ref.toLowerCase(), v.verdict);
    }
  } catch {
    // Unparseable verdicts → trust nothing dropped (fail-open, still logged).
  }
  return out;
}

function verifierItemLines(ext: DatasheetExtraction): { ref: string; line: string }[] {
  if (ext.facet === "specs") {
    return ext.payload.items.map((it) => {
      const ref = it.symbol && it.symbol.trim() !== "" ? it.symbol : it.parameter;
      const v = it.value;
      return {
        ref,
        line: `${ref}: min=${v.min ?? "-"} typ=${v.typ ?? "-"} max=${v.max ?? "-"} ${v.unit} @ ${it.provenance.label} p${it.provenance.page}`,
      };
    });
  }
  if (ext.facet === "pins") {
    return ext.payload.pins.map((p) => ({
      ref: p.number,
      line: `pin ${p.number}: name=${p.name} type=${p.type}`,
    }));
  }
  return ext.payload.components.map((c) => ({
    ref: c.designator,
    line: `${c.designator} (${c.kind}${c.value ? ` ${c.value}` : ""})`,
  }));
}

const isWrong = (v: string | undefined): boolean => v === "wrong" || v === "not_at_cited_location";

/** Drop verifier-rejected specs/pins; downgrade circuit confidence if any wrong. */
function applyVerdicts(
  ext: DatasheetExtraction,
  verdicts: Map<string, string>,
): DatasheetExtraction {
  if (ext.facet === "specs") {
    const items = ext.payload.items.filter((it) => {
      const ref = (it.symbol && it.symbol.trim() !== "" ? it.symbol : it.parameter).toLowerCase();
      return !isWrong(verdicts.get(ref));
    });
    return { ...ext, payload: { ...ext.payload, items } };
  }
  if (ext.facet === "pins") {
    const pins = ext.payload.pins.filter((p) => !isWrong(verdicts.get(p.number.toLowerCase())));
    return { ...ext, payload: { ...ext.payload, pins, pin_count: pins.length } };
  }
  const anyWrong = ext.payload.components.some((c) =>
    isWrong(verdicts.get(c.designator.toLowerCase())),
  );
  return anyWrong ? { ...ext, payload: { ...ext.payload, confidence: "low" } } : ext;
}

export const verifier: StrategyFn = async (ctx) => {
  const first = await extractWithRetry(ctx, baseMessages(ctx));
  if (!first.ok) return { ok: false, reason: first.reason, calls: first.calls };

  const lines = verifierItemLines(first.extraction);
  const verifyPrompt = `You are a SKEPTICAL verifier. Below are extracted ${ctx.facet} claims for ${ctx.part.mpn}. Re-read the page images and, for each claim, decide whether it is faithfully supported.\n\nClaims:\n${lines.map((l) => l.line).join("\n")}\n\nReturn ONLY JSON: {"verdicts":[{"ref":"<the leading identifier of each claim>","verdict":"confirmed"|"wrong"|"not_at_cited_location"}]}. Mark "wrong" only when you can see the claim is unsupported.`;
  const res = await ctx.transport.complete({
    system: "You verify datasheet extractions against page images. Output JSON only.",
    messages: [userMessage(verifyPrompt, ctx.images)],
    model: ctx.model.id,
    maxTokens: ctx.model.maxTokens,
    forceJson: true,
  });
  const verdicts = parseVerdicts(res.text);
  const corrected = applyVerdicts(first.extraction, verdicts);
  return { ok: true, extraction: corrected, calls: first.calls + 1 };
};

// ── self-consistency ×3 (circuits only) ──

const NORM = (s: string): string => s.toLowerCase().replace(/[\s]+/g, "").replace(/[µμ]/g, "u");

/** Merge N reference circuits: keep components/connections present in ≥2 runs. */
export function mergeCircuits(circuits: ReferenceCircuit[]): ReferenceCircuit {
  const n = circuits.length;
  const quorum = Math.floor(n / 2) + 1; // ≥2 of 3

  // Component identity = designator (stable across re-runs of one figure).
  const byDesignator = new Map<
    string,
    { kinds: string[]; values: string[]; runs: number; pins: Map<string, string[][]> }
  >();
  for (const circuit of circuits) {
    for (const comp of circuit.components) {
      const entry = byDesignator.get(comp.designator) ?? {
        kinds: [],
        values: [],
        runs: 0,
        pins: new Map<string, string[][]>(),
      };
      entry.kinds.push(comp.kind);
      if (comp.value) entry.values.push(comp.value);
      entry.runs++;
      for (const p of comp.pins) {
        const arr = entry.pins.get(p.pin) ?? [];
        arr.push(p.connects_to);
        entry.pins.set(p.pin, arr);
      }
      byDesignator.set(comp.designator, entry);
    }
  }

  const majority = <T>(xs: T[]): T | undefined => {
    const counts = new Map<string, { v: T; c: number }>();
    for (const x of xs) {
      const k = typeof x === "string" ? (x as string) : JSON.stringify(x);
      const e = counts.get(k) ?? { v: x, c: 0 };
      e.c++;
      counts.set(k, e);
    }
    let best: { v: T; c: number } | undefined;
    for (const e of counts.values()) if (!best || e.c > best.c) best = e;
    return best?.v;
  };

  const keptDesignators = new Set<string>();
  for (const [des, e] of byDesignator) if (e.runs >= quorum) keptDesignators.add(des);

  const railCounts = new Map<string, number>();
  for (const circuit of circuits)
    for (const r of new Set(circuit.rails)) {
      railCounts.set(r, (railCounts.get(r) ?? 0) + 1);
    }

  const targetKept = (t: string): boolean => {
    if (t === "NC") return false;
    const dot = t.indexOf(".");
    if (dot >= 0) return keptDesignators.has(t.slice(0, dot));
    return true; // rail name — kept, rails[] finalized below
  };

  const components: ReferenceCircuit["components"] = [];
  for (const [des, e] of byDesignator) {
    if (!keptDesignators.has(des)) continue;
    const pins: ReferenceCircuit["components"][number]["pins"] = [];
    for (const [pin, targetLists] of e.pins) {
      // A target is kept if it appears (normalized) in ≥quorum of this
      // component's runs and points at a kept component or a rail.
      const counts = new Map<string, { raw: string; c: number }>();
      for (const list of targetLists) {
        for (const raw of new Set(list)) {
          const k = NORM(raw);
          const cur = counts.get(k) ?? { raw, c: 0 };
          cur.c++;
          counts.set(k, cur);
        }
      }
      const kept = [...counts.values()]
        .filter((v) => v.c >= quorum && targetKept(v.raw))
        .map((v) => v.raw);
      pins.push({ pin, connects_to: kept });
    }
    components.push({
      designator: des,
      kind: majority(e.kinds) ?? "other",
      ...(e.values.length > 0 ? { value: majority(e.values) } : {}),
      pins,
    } as ReferenceCircuit["components"][number]);
  }

  const rails = [...railCounts.entries()].filter(([, c]) => c >= quorum).map(([r]) => r);
  const base = circuits[0];
  return {
    device: base.device,
    title: base.title,
    provenance: base.provenance,
    components,
    rails,
    notes: base.notes,
    confidence: "medium",
  };
}

export const selfConsistency3: StrategyFn = async (ctx) => {
  if (ctx.facet !== "circuit") {
    return { ok: false, reason: "self-consistency-3 applies to the circuit facet only", calls: 0 };
  }
  const runs: ReferenceCircuit[] = [];
  let calls = 0;
  let lastErr = "";
  for (let i = 0; i < 3; i++) {
    const res = await extractWithRetry(ctx, baseMessages(ctx));
    calls += res.calls;
    if (res.ok && res.extraction.facet === "circuit") runs.push(res.extraction.payload);
    else if (!res.ok) lastErr = res.reason;
  }
  if (runs.length < 2) {
    return {
      ok: false,
      reason: `self-consistency-3: fewer than 2 usable runs (${lastErr})`,
      calls,
    };
  }
  const merged = mergeCircuits(runs);
  const extraction: DatasheetExtraction = {
    schema_version: 1,
    facet: "circuit",
    device: merged.device,
    payload: merged,
  };
  const parsed = DatasheetExtractionSchema.safeParse(extraction);
  if (!parsed.success) {
    return { ok: false, reason: "self-consistency-3 produced an invalid merged circuit", calls };
  }
  return { ok: true, extraction: parsed.data, calls };
};

// ── registry ──

export const STRATEGIES: Record<string, StrategyFn> = {
  "single-pass": singlePass,
  "validate-retry": validateRetry,
  verifier,
  "self-consistency-3": selfConsistency3,
};
