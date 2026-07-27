/**
 * Core logic for `pcbpal datasheet extract --prepare`. No I/O formatting,
 * no CLI registration — see design-docs/datasheet_understanding_evals.md
 * §2 (sub-agent decomposition) and §5 (CLI surface).
 *
 * Builds a task package for an LLM sub-agent: rendered page images, a
 * JSON Schema for the requested facet, and an instructions.md prompt. The
 * sub-agent fills the schema and writes it to `output_file`, then runs
 * `datasheet validate` in a loop until clean (§4 faithfulness mechanisms
 * #1 schema-forced output with provenance, #2 deterministic validate).
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { PinTable, ReferenceCircuit, SpecTable } from "../../schemas/datasheet.js";
import { datasheetsDir, resolveCachedDatasheet, slugify } from "../../services/datasheets.js";
import { pdfInfo, renderPdfPages } from "../../services/pdf.js";
import { findProjectRoot } from "../../services/project.js";
import { buildPageIndex, type PageIndexEntry, parsePageSpec } from "./pages.js";
import { circuitPrompt, type PromptContext, pinsPrompt, specsPrompt } from "./prompts.js";

export type ExtractFacet = "specs" | "pins" | "circuit";

export interface ExtractOptions {
  source: string; // mpn | lcsc id | sha prefix | pdf path
  facet: ExtractFacet;
  pages?: string; // page spec "3,7-9"; auto-detected when absent
  dpi?: number; // default 200
  device?: string; // default: cached mpn or pdf basename
}

export interface TaskManifest {
  device: string;
  facet: ExtractFacet;
  pdf: string;
  pdf_sha256: string;
  pages: number[];
  images: string[]; // relative to taskDir
  schema_file: "schema.json";
  instructions_file: "instructions.md";
  output_file: string; // absolute path the agent must write extraction JSON to
  validate_command: string;
  created_at: string;
  truncated_pages?: true;
}

export interface ExtractPrepareResult {
  ok: true;
  taskDir: string;
  manifest: TaskManifest;
  autoDetectedPages: boolean;
}

const MAX_AUTO_PAGES = 8;

// Facet keyword heuristics for auto-detecting which pages to render, applied
// against the figure/table captions the page index picks up from the text
// layer (see pages.ts buildPageIndex).
const FACET_CAPTION_RE: Record<ExtractFacet, RegExp> = {
  circuit: /typical application|application circuit|reference design|application information/i,
  pins: /pin (configuration|description|assignment|function)|pinout/i,
  specs: /electrical characteristics|absolute maximum|recommended operating|specifications/i,
};

function facetPayloadSchema(facet: ExtractFacet) {
  switch (facet) {
    case "specs":
      return SpecTable;
    case "pins":
      return PinTable;
    case "circuit":
      return ReferenceCircuit;
  }
}

/**
 * Envelope schema narrowed to one facet, mirroring the shape of
 * `DatasheetExtraction` in src/schemas/datasheet.ts (that schema is a
 * discriminated union across all facets; this builds the single-facet
 * variant used to generate schema.json for the sub-agent).
 */
export function envelopeSchemaFor(facet: ExtractFacet) {
  return z.object({
    schema_version: z.literal(1),
    facet: z.literal(facet),
    device: z.string(),
    pdf_sha256: z.string().optional(),
    extractor: z.object({ strategy: z.string(), model: z.string() }).optional(),
    extracted_at: z.string().datetime().optional(),
    payload: facetPayloadSchema(facet),
  });
}

export function promptFor(facet: ExtractFacet, ctx: PromptContext): string {
  switch (facet) {
    case "specs":
      return specsPrompt(ctx);
    case "pins":
      return pinsPrompt(ctx);
    case "circuit":
      return circuitPrompt(ctx);
  }
}

function formatDetectedCaptions(index: PageIndexEntry[]): string {
  const lines = index
    .filter((e) => e.figures.length > 0 || e.tables.length > 0)
    .map((e) => `  page ${e.page}: ${[...e.figures, ...e.tables].join(" | ")}`);
  return lines.length > 0
    ? `Detected captions:\n${lines.join("\n")}`
    : "No figure/table captions were detected on any page.";
}

/**
 * Auto-detect which pages hold the requested facet by matching figure/table
 * captions against a per-facet keyword heuristic. Throws (listing detected
 * captions) when nothing matches, so the caller can pass --pages explicitly.
 */
export async function autoDetectPages(
  pdfPath: string,
  totalPages: number,
  facet: ExtractFacet,
): Promise<{ pages: number[]; truncated: boolean }> {
  const allPages = Array.from({ length: totalPages }, (_, i) => i + 1);
  const index = await buildPageIndex(pdfPath, allPages);
  const re = FACET_CAPTION_RE[facet];

  const matched = index
    .filter(
      (entry) => entry.figures.some((f) => re.test(f)) || entry.tables.some((t) => re.test(t)),
    )
    .map((entry) => entry.page);

  if (matched.length === 0) {
    throw new Error(
      `Could not auto-detect pages for facet "${facet}" in ${pdfPath} — no figure/table caption ` +
        `matched the expected heading pattern.\n${formatDetectedCaptions(index)}\n` +
        `Pass --pages explicitly (e.g. --pages 3,7-9).`,
    );
  }

  if (matched.length > MAX_AUTO_PAGES) {
    return { pages: matched.slice(0, MAX_AUTO_PAGES), truncated: true };
  }
  return { pages: matched, truncated: false };
}

/**
 * Resolve `source` to a cached/on-disk PDF, select pages (explicit or
 * auto-detected), render them, and write a task package (page PNGs,
 * schema.json, instructions.md, manifest.json) to
 * `.pcbpal/datasheets/tasks/<device-slug>-<facet>/`.
 */
export async function extractPrepare(opts: ExtractOptions): Promise<ExtractPrepareResult> {
  const root = await findProjectRoot();
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }

  const resolved = await resolveCachedDatasheet(root, opts.source);
  if (!resolved) {
    throw new Error(
      `Datasheet not found: ${opts.source} (not a cached mpn/lcsc/sha256 prefix and not an existing file path)`,
    );
  }
  const pdfPath = resolved.path;
  const info = await pdfInfo(pdfPath);

  const device = opts.device ?? resolved.mpn ?? basename(pdfPath).replace(/\.pdf$/i, "");

  let pages: number[];
  let autoDetectedPages: boolean;
  let truncatedPages: true | undefined;

  if (opts.pages) {
    pages = parsePageSpec(opts.pages, info.pages);
    const outOfRange = pages.filter((p) => p > info.pages);
    if (outOfRange.length > 0) {
      throw new Error(
        `Requested page(s) ${outOfRange.join(", ")} exceed document length (${info.pages} pages)`,
      );
    }
    autoDetectedPages = false;
  } else {
    const detected = await autoDetectPages(pdfPath, info.pages, opts.facet);
    pages = detected.pages;
    autoDetectedPages = true;
    if (detected.truncated) truncatedPages = true;
  }

  const dpi = opts.dpi ?? 200;
  const deviceSlug = slugify(device);
  const taskDir = join(datasheetsDir(root), "tasks", `${deviceSlug}-${opts.facet}`);
  const pagesOutDir = join(taskDir, "pages");
  const extractedDir = join(datasheetsDir(root), "extracted");

  // Idempotent: wipe any previous task package for this device+facet.
  await rm(taskDir, { recursive: true, force: true });
  await mkdir(taskDir, { recursive: true });
  await mkdir(extractedDir, { recursive: true });

  const rendered = await renderPdfPages(pdfPath, {
    pages,
    dpi,
    outDir: pagesOutDir,
    prefix: "page",
  });
  const images = rendered.map((p) => relative(taskDir, p));

  const outputFile = join(extractedDir, `${deviceSlug}-${opts.facet}.json`);
  const validateCommand = `pcbpal datasheet validate ${outputFile} --json`;

  const schema = zodToJsonSchema(envelopeSchemaFor(opts.facet));
  await writeFile(join(taskDir, "schema.json"), `${JSON.stringify(schema, null, 2)}\n`, "utf-8");

  const promptCtx: PromptContext = {
    device,
    pages,
    outputFile,
    validateCommand,
    pdfSha256: resolved.sha256,
  };
  const instructions = promptFor(opts.facet, promptCtx);
  await writeFile(join(taskDir, "instructions.md"), instructions, "utf-8");

  const manifest: TaskManifest = {
    device,
    facet: opts.facet,
    pdf: pdfPath,
    pdf_sha256: resolved.sha256,
    pages,
    images,
    schema_file: "schema.json",
    instructions_file: "instructions.md",
    output_file: outputFile,
    validate_command: validateCommand,
    created_at: new Date().toISOString(),
    ...(truncatedPages ? { truncated_pages: true as const } : {}),
  };
  await writeFile(
    join(taskDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );

  return { ok: true, taskDir, manifest, autoDetectedPages };
}
