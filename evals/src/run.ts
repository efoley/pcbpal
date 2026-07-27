/**
 * Eval runner CLI.
 *
 *   bun evals/src/run.ts --parts ams1117-3.3 --facets specs --strategy single-pass \
 *       --model claude-opus-4-8 --dry-run
 *
 * Offline-first: `--dry-run` bypasses the PDF + API stages entirely and feeds
 * each strategy the golden extraction via MockTransport, so the whole pipeline
 * (prompt build → strategy → scoring → report → baseline diff) runs with no
 * network and no API key and yields perfect scores — a plumbing check.
 *
 * A live run (on a machine with poppler + ANTHROPIC_API_KEY) renders PDF pages
 * to PNGs and calls the Anthropic API through AnthropicTransport.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { envelopeSchemaFor, promptFor } from "../../src/commands/datasheet/extract.js";
import type { PromptContext } from "../../src/commands/datasheet/prompts.js";
import type { DatasheetExtraction } from "../../src/schemas/datasheet.js";
import { fetchDatasheet } from "../../src/services/datasheets.js";
import { renderPdfPages } from "../../src/services/pdf.js";
import { diffBaseline, renderReport, renderTable } from "./report.js";
import { scoreCircuit } from "./score-circuit.js";
import { scorePins } from "./score-pins.js";
import { scoreSpecs } from "./score-specs.js";
import { STRATEGIES, type StrategyContext } from "./strategies.js";
import { AnthropicTransport, type ContentBlock, MockTransport } from "./transport.js";
import {
  Baseline,
  type CaseResult,
  type CaseScore,
  type EvalCase,
  type EvalRun,
  Facet,
  GoldenFile,
  Manifest,
  type ManifestPart,
  ModelSpec,
  Strategy,
} from "./types.js";

// ── Paths ──

const EVALS_DIR = join(import.meta.dir, "..");
const MANIFEST_PATH = join(EVALS_DIR, "datasheets", "manifest.json");
const GOLDEN_DIR = join(EVALS_DIR, "datasheets", "golden");
const CACHE_DIR = join(EVALS_DIR, "datasheets", "cache");
const RESULTS_DIR = join(EVALS_DIR, "results");
const BASELINE_PATH = join(EVALS_DIR, "baseline.json");

// ── Arg parsing (hand-rolled: no commander help/exit surprises) ──

interface Args {
  parts?: string[];
  facets?: Facet[];
  strategy: Strategy;
  model: string;
  maxTokens: number;
  dryRun: boolean;
  fetch: boolean;
  acceptBaseline: boolean;
  runLabel?: string;
  dpi: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    strategy: "single-pass",
    model: "claude-opus-4-8",
    maxTokens: 8192,
    dryRun: false,
    fetch: false,
    acceptBaseline: false,
    dpi: 200,
  };
  const list = (v: string): string[] =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => argv[++i];
    switch (a) {
      case "--parts":
        args.parts = list(next());
        break;
      case "--facets":
        args.facets = list(next()).map((f) => Facet.parse(f));
        break;
      case "--strategy":
        args.strategy = Strategy.parse(next());
        break;
      case "--model":
        args.model = next();
        break;
      case "--max-tokens":
        args.maxTokens = Number.parseInt(next(), 10);
        break;
      case "--dpi":
        args.dpi = Number.parseInt(next(), 10);
        break;
      case "--run-label":
        args.runLabel = next();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--fetch":
        args.fetch = true;
        break;
      case "--accept-baseline":
        args.acceptBaseline = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `pcbpal datasheet eval runner\n\n` +
      `Usage: bun evals/src/run.ts [options]\n\n` +
      `  --parts a,b          part ids from manifest (default: all)\n` +
      `  --facets specs,pins  facets to run (default: all)\n` +
      `  --strategy <s>       single-pass | validate-retry | verifier | self-consistency-3\n` +
      `  --model <id>         model id (default: claude-opus-4-8)\n` +
      `  --max-tokens <n>     per-call max tokens (default: 8192)\n` +
      `  --dpi <n>            page render DPI (default: 200)\n` +
      `  --dry-run            offline plumbing check (MockTransport echoes golden)\n` +
      `  --fetch              download missing PDFs into evals/datasheets/cache/\n` +
      `  --accept-baseline    write this run's scores into baseline.json\n` +
      `  --run-label <s>      label for the results directory\n`,
  );
}

// ── Golden loading + case expansion ──

async function loadManifest(): Promise<Manifest> {
  const raw = JSON.parse(await readFile(MANIFEST_PATH, "utf-8"));
  return Manifest.parse(raw);
}

function goldenPathFor(part: ManifestPart, facet: Facet, label?: string): string {
  const file = facet === "circuit" ? `circuit-${label}.json` : `${facet}.json`;
  return join(GOLDEN_DIR, part.id, file);
}

function pagesHint(part: ManifestPart, facet: Facet, label?: string): number[] | undefined {
  if (!part.pages) return undefined;
  const key = facet === "circuit" && label ? `circuit-${label}` : facet;
  return part.pages[key] ?? part.pages[facet];
}

function expandCases(manifest: Manifest, args: Args): EvalCase[] {
  const cases: EvalCase[] = [];
  const partFilter = args.parts ? new Set(args.parts) : null;
  const facetFilter = args.facets ? new Set(args.facets) : null;

  for (const part of manifest.parts) {
    if (partFilter && !partFilter.has(part.id)) continue;
    for (const facet of part.facets) {
      if (facetFilter && !facetFilter.has(facet)) continue;
      const labels = facet === "circuit" ? part.circuit_labels : [undefined];
      for (const label of labels) {
        const goldenPath = goldenPathFor(part, facet, label);
        if (!existsSync(goldenPath)) continue; // no golden authored for this facet
        cases.push({
          partId: part.id,
          mpn: part.mpn,
          lcsc: part.lcsc,
          facet,
          label,
          goldenPath,
          pdfUrl: part.pdf_url,
          pdfSha256: part.pdf_sha256,
          pages: pagesHint(part, facet, label),
        });
      }
    }
  }
  return cases;
}

// ── Scoring dispatch ──

function scoreCase(
  facet: Facet,
  golden: DatasheetExtraction,
  cand: DatasheetExtraction,
): CaseScore {
  if (facet === "specs" && golden.facet === "specs" && cand.facet === "specs") {
    return scoreSpecs(golden.payload, cand.payload);
  }
  if (facet === "pins" && golden.facet === "pins" && cand.facet === "pins") {
    return scorePins(golden.payload, cand.payload);
  }
  if (facet === "circuit" && golden.facet === "circuit" && cand.facet === "circuit") {
    return scoreCircuit(golden.payload, cand.payload);
  }
  throw new Error(`facet mismatch scoring ${facet}`);
}

// ── Dry-run scripted responses (golden echoed through the strategy) ──

function dryRunResponses(strategy: Strategy, goldenJson: string): string[] {
  switch (strategy) {
    case "single-pass":
    case "validate-retry":
      return [goldenJson];
    case "verifier":
      return [goldenJson, '{"verdicts":[]}'];
    case "self-consistency-3":
      return [goldenJson, goldenJson, goldenJson];
  }
}

// ── PDF stage (live only) ──

async function ensurePdf(
  ec: EvalCase,
  args: Args,
): Promise<{ path: string; sha256: string } | { skip: string }> {
  await mkdir(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `${ec.partId}.pdf`);
  if (existsSync(cachePath)) {
    const sha = createHash("sha256")
      .update(await readFile(cachePath))
      .digest("hex");
    return { path: cachePath, sha256: sha };
  }
  if (!args.fetch) {
    return { skip: `PDF not in cache (evals/datasheets/cache/${ec.partId}.pdf); pass --fetch` };
  }
  try {
    // Reuse the shipped fetcher (checksum/dedupe/PDF-magic validation), then
    // copy the downloaded file into our own cache under a stable name.
    const rec = await fetchDatasheet(EVALS_DIR, {
      url: ec.pdfUrl,
      mpn: ec.mpn,
      ...(ec.lcsc ? { lcsc: ec.lcsc } : {}),
    });
    await cp(rec.path, cachePath);
    return { path: cachePath, sha256: rec.sha256 };
  } catch (e) {
    return { skip: `fetch failed: ${(e as Error).message}` };
  }
}

async function loadImages(pdfPath: string, pages: number[], dpi: number): Promise<ContentBlock[]> {
  const outDir = join(CACHE_DIR, "pages", basename(pdfPath, ".pdf"));
  await mkdir(outDir, { recursive: true });
  const files = await renderPdfPages(pdfPath, { pages, dpi, outDir, prefix: "page" });
  const blocks: ContentBlock[] = [];
  for (const f of files) {
    const data = (await readFile(f)).toString("base64");
    blocks.push({ type: "image_base64_png", data });
  }
  return blocks;
}

// ── Per-case execution ──

async function runCase(ec: EvalCase, args: Args, model: ModelSpec): Promise<CaseResult> {
  const goldenRaw = JSON.parse(await readFile(ec.goldenPath, "utf-8"));
  const golden = GoldenFile.parse(goldenRaw);
  const goldenExtraction = golden.extraction;
  const base: Omit<CaseResult, "score" | "skipped" | "calls"> = {
    partId: ec.partId,
    mpn: ec.mpn,
    facet: ec.facet,
    label: ec.label,
    strategy: args.strategy,
    model: model.id,
    unverifiedGolden: !golden.verified,
  };

  if (!golden.verified) {
    process.stderr.write(
      `  ⚠️  golden ${ec.partId}/${ec.facet}${ec.label ? `-${ec.label}` : ""} is UNVERIFIED — scores are plumbing signal, not truth\n`,
    );
  }

  // Build the extraction prompt + schema (used in both modes).
  const promptCtx: PromptContext = {
    device: goldenExtraction.device,
    pages: ec.pages ?? [],
    outputFile: "(eval: not written)",
    validateCommand: "(eval: scored in-process)",
    pdfSha256: ec.pdfSha256,
  };
  const prompt = promptFor(ec.facet, promptCtx);
  const schemaJson = JSON.stringify(zodToJsonSchema(envelopeSchemaFor(ec.facet)), null, 2);

  // Transport + images.
  let images: ContentBlock[] = [];
  let transport: MockTransport | AnthropicTransport;
  if (args.dryRun) {
    transport = new MockTransport(dryRunResponses(args.strategy, JSON.stringify(goldenExtraction)));
  } else {
    const pdf = await ensurePdf(ec, args);
    if ("skip" in pdf) {
      return { ...base, skipped: true, reason: pdf.skip, calls: 0, score: null };
    }
    if (!ec.pages || ec.pages.length === 0) {
      return {
        ...base,
        skipped: true,
        reason: "no page hints in manifest (add pages.<facet>) and auto-detect is dry-run-only",
        calls: 0,
        score: null,
      };
    }
    try {
      images = await loadImages(pdf.path, ec.pages, args.dpi);
    } catch (e) {
      return {
        ...base,
        skipped: true,
        reason: `render failed: ${(e as Error).message}`,
        calls: 0,
        score: null,
      };
    }
    transport = new AnthropicTransport();
  }

  const ctx: StrategyContext = {
    part: { id: ec.partId, mpn: ec.mpn },
    facet: ec.facet,
    images,
    prompt,
    schemaJson,
    transport,
    model,
  };

  const strategyFn = STRATEGIES[args.strategy];
  const result = await strategyFn(ctx);
  if (!result.ok) {
    // A strategy failure is a total omission — score an empty candidate so the
    // case still contributes a (bad) number rather than vanishing.
    const empty = emptyExtraction(ec.facet, goldenExtraction.device);
    const score = scoreCase(ec.facet, goldenExtraction, empty);
    return { ...base, skipped: false, reason: result.reason, calls: result.calls, score };
  }

  const score = scoreCase(ec.facet, goldenExtraction, result.extraction);
  return { ...base, skipped: false, calls: result.calls, score };
}

function emptyExtraction(facet: Facet, device: string): DatasheetExtraction {
  if (facet === "specs") {
    return {
      schema_version: 1,
      facet,
      device,
      payload: { device, section: "other", items: [], not_found: [] },
    };
  }
  if (facet === "pins") {
    return {
      schema_version: 1,
      facet,
      device,
      payload: { device, package: "", pin_count: 1, pins: [] },
    };
  }
  return {
    schema_version: 1,
    facet,
    device,
    payload: {
      device,
      title: "(strategy failure)",
      provenance: { page: 1, label: "-" },
      components: [],
      rails: [],
      notes: [],
      confidence: "low",
    },
  };
}

// ── Main ──

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const model = ModelSpec.parse({ id: args.model, maxTokens: args.maxTokens });
  const manifest = await loadManifest();
  const cases = expandCases(manifest, args);

  if (cases.length === 0) {
    process.stderr.write("No matching eval cases (check --parts/--facets and golden files).\n");
    return 0;
  }

  process.stderr.write(
    `Running ${cases.length} case(s) | strategy=${args.strategy} model=${model.id} dry-run=${args.dryRun}\n`,
  );

  const results: CaseResult[] = [];
  for (const ec of cases) {
    process.stderr.write(`• ${ec.partId} / ${ec.facet}${ec.label ? `-${ec.label}` : ""} … `);
    try {
      const r = await runCase(ec, args, model);
      results.push(r);
      const status = r.skipped
        ? `skipped (${r.reason})`
        : `headline=${(r.score?.headline ?? 0).toFixed(3)} halluc=${(r.score?.hallucination_rate ?? 0).toFixed(3)}${r.reason ? ` [${r.reason}]` : ""}`;
      process.stderr.write(`${status}\n`);
    } catch (e) {
      process.stderr.write(`ERROR ${(e as Error).message}\n`);
      results.push({
        partId: ec.partId,
        mpn: ec.mpn,
        facet: ec.facet,
        label: ec.label,
        strategy: args.strategy,
        model: model.id,
        skipped: true,
        reason: `error: ${(e as Error).message}`,
        unverifiedGolden: false,
        calls: 0,
        score: null,
      });
    }
  }

  const run: EvalRun = {
    runLabel: args.runLabel ?? `${args.strategy}-${args.dryRun ? "dry" : "live"}`,
    timestamp: new Date().toISOString(),
    model: model.id,
    strategy: args.strategy,
    dryRun: args.dryRun,
    cases: results,
  };

  // Baseline diff.
  const baseline: Baseline = existsSync(BASELINE_PATH)
    ? Baseline.parse(JSON.parse(await readFile(BASELINE_PATH, "utf-8")))
    : {};
  const diff = diffBaseline(run, baseline);

  // Write results.
  const stamp = run.timestamp.replace(/[:.]/g, "-");
  const outDir = join(RESULTS_DIR, `${stamp}-${run.runLabel}`);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  const report = renderReport(run, diff);
  await writeFile(join(outDir, "report.md"), report);

  // Summary table to stdout.
  process.stdout.write(`${renderTable(run)}\n\n`);
  process.stdout.write(`Results: ${join(outDir, "run.json")}\n`);

  if (args.acceptBaseline) {
    const merged: Baseline = { ...baseline, ...diff.current };
    await writeFile(BASELINE_PATH, `${JSON.stringify(merged, null, 2)}\n`);
    process.stdout.write(
      `Baseline updated: ${Object.keys(diff.current).length} case(s) written.\n`,
    );
    return 0;
  }

  if (diff.regressions.length > 0) {
    process.stderr.write(`\n${diff.regressions.length} regression(s) vs baseline:\n`);
    for (const r of diff.regressions)
      process.stderr.write(`  ✗ ${r.key}: ${r.reasons.join("; ")}\n`);
    return 1;
  }
  process.stdout.write("No regressions vs baseline.\n");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`Fatal: ${(e as Error).stack ?? (e as Error).message}\n`);
    process.exit(1);
  });
