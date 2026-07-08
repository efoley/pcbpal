/**
 * Core logic for `pcbpal datasheet pages`. No I/O formatting, no CLI
 * registration — see design-docs/datasheet_understanding_evals.md §5.
 */

import { join } from "node:path";
import { pagesDir, resolveCachedDatasheet } from "../../services/datasheets.js";
import { pdfInfo, pdfText, renderPdfPages } from "../../services/pdf.js";
import { findProjectRoot } from "../../services/project.js";

export interface PagesOptions {
  source: string;
  pages?: string;
  dpi?: number;
  list?: boolean;
}

export interface PageIndexEntry {
  page: number;
  figures: string[];
  tables: string[];
}

export interface PagesListResult {
  ok: true;
  pdf: string;
  pages: number;
  title?: string;
  index: PageIndexEntry[];
}

export interface PagesRenderResult {
  ok: true;
  pdf: string;
  outDir: string;
  images: string[];
}

export type PagesResult = PagesListResult | PagesRenderResult;

const FIGURE_RE = /^(?:Figure|Fig\.?)\s+\d+[.:]?\s*(.*)$/gim;
const TABLE_RE = /^Table\s+\d+[.:]?\s*(.*)$/gim;
const MAX_CAPTION_LEN = 80;

function extractCaptions(text: string, re: RegExp): string[] {
  const captions: string[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((match = re.exec(text)) !== null) {
    const full = match[0].trim().replace(/\s+/g, " ");
    captions.push(full.length > MAX_CAPTION_LEN ? `${full.slice(0, MAX_CAPTION_LEN)}…` : full);
  }
  return captions;
}

/**
 * Build a page index (figure/table captions per page) for the given pages,
 * reading each page's text layer independently. Shared by `pagesCommand`
 * (--list) and `extract --prepare`'s facet auto-detection.
 */
export async function buildPageIndex(pdfPath: string, pages: number[]): Promise<PageIndexEntry[]> {
  const index: PageIndexEntry[] = [];
  for (const page of pages) {
    const text = await pdfText(pdfPath, { first: page, last: page });
    index.push({
      page,
      figures: extractCaptions(text, FIGURE_RE),
      tables: extractCaptions(text, TABLE_RE),
    });
  }
  return index;
}

/**
 * Parse a page spec like "3,7-9" into a sorted, de-duplicated list of page
 * numbers. "all" expands to [1..totalPages] and requires totalPages.
 */
export function parsePageSpec(spec: string, totalPages?: number): number[] {
  const trimmed = spec.trim();
  if (trimmed.toLowerCase() === "all") {
    if (totalPages === undefined) {
      throw new Error('"all" page spec requires a known total page count');
    }
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages = new Set<number>();
  for (const part of trimmed.split(",")) {
    const piece = part.trim();
    if (piece === "") continue;

    const rangeMatch = piece.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < 1 || end < start) {
        throw new Error(`Invalid page range "${piece}" in page spec "${spec}"`);
      }
      for (let p = start; p <= end; p++) pages.add(p);
      continue;
    }

    const single = piece.match(/^(\d+)$/);
    if (single) {
      const p = parseInt(single[1], 10);
      if (p < 1) {
        throw new Error(`Invalid page number "${piece}" in page spec "${spec}"`);
      }
      pages.add(p);
      continue;
    }

    throw new Error(`Invalid page spec segment "${piece}" in "${spec}" (expected "3" or "7-9")`);
  }

  if (pages.size === 0) {
    throw new Error(`Page spec "${spec}" did not resolve to any pages`);
  }

  return [...pages].sort((a, b) => a - b);
}

/**
 * Resolve `source` (mpn / lcsc id / sha256 prefix / direct file path) to a
 * cached datasheet, then either build a page index (--list) or render the
 * requested pages to PNG.
 */
export async function pagesCommand(opts: PagesOptions): Promise<PagesResult> {
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
  const sha8 = resolved.sha256.slice(0, 8);

  const info = await pdfInfo(pdfPath);
  const requested = parsePageSpec(opts.pages ?? "all", info.pages);
  const outOfRange = requested.filter((p) => p > info.pages);
  if (outOfRange.length > 0) {
    throw new Error(
      `Requested page(s) ${outOfRange.join(", ")} exceed document length (${info.pages} pages)`,
    );
  }

  if (opts.list) {
    const index = await buildPageIndex(pdfPath, requested);
    return { ok: true, pdf: pdfPath, pages: info.pages, title: info.title, index };
  }

  const dpi = opts.dpi ?? 200;
  const outDir = join(pagesDir(root), sha8);
  const images = await renderPdfPages(pdfPath, { pages: requested, dpi, outDir, prefix: "page" });

  return { ok: true, pdf: pdfPath, outDir, images };
}
