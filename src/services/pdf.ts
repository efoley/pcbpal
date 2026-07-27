/**
 * Thin wrappers around poppler-utils (pdftoppm, pdftotext, pdfinfo).
 *
 * These are the only PDF tools pcbpal shells out to — no PDF parsing
 * library is bundled. All functions throw a typed Error with an
 * "install poppler-utils" message when the underlying binary is missing.
 */

import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

export interface PdfTools {
  pdftoppm: boolean;
  pdftotext: boolean;
  pdfinfo: boolean;
}

// Cached across calls in this module — the toolchain doesn't change
// mid-process, and probing three binaries on every call is wasteful.
let cachedTools: PdfTools | null = null;

async function checkTool(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "pipe" });
    await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Detect which poppler-utils binaries are on PATH. Result is cached for
 * the lifetime of the process; pass `force: true` to re-probe.
 */
export async function detectPdfTools(opts?: { force?: boolean }): Promise<PdfTools> {
  if (cachedTools && !opts?.force) {
    return cachedTools;
  }
  const [pdftoppm, pdftotext, pdfinfo] = await Promise.all([
    checkTool("pdftoppm"),
    checkTool("pdftotext"),
    checkTool("pdfinfo"),
  ]);
  cachedTools = { pdftoppm, pdftotext, pdfinfo };
  return cachedTools;
}

function installMessage(tool: string): string {
  return `${tool} not found — install poppler-utils (e.g. \`apt install poppler-utils\` or \`brew install poppler\`)`;
}

async function ensureTool(tool: keyof PdfTools): Promise<void> {
  const tools = await detectPdfTools();
  if (!tools[tool]) {
    throw new Error(installMessage(tool));
  }
}

/**
 * Run `pdfinfo` on a PDF and parse page count + title.
 */
export async function pdfInfo(path: string): Promise<{ pages: number; title?: string }> {
  await ensureTool("pdfinfo");

  const proc = Bun.spawn(["pdfinfo", path], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`pdfinfo failed for ${path}: ${stderr.trim() || stdout.trim()}`);
  }

  const pagesMatch = stdout.match(/^Pages:\s+(\d+)/m);
  if (!pagesMatch) {
    throw new Error(`pdfinfo output for ${path} did not include a Pages count`);
  }
  const titleMatch = stdout.match(/^Title:\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : undefined;

  return { pages: parseInt(pagesMatch[1], 10), title: title || undefined };
}

/**
 * Extract the text layer via `pdftotext -layout`, optionally restricted
 * to a page range. Output is written to stdout ("-") rather than a file.
 */
export async function pdfText(
  path: string,
  opts?: { first?: number; last?: number },
): Promise<string> {
  await ensureTool("pdftotext");

  const args = ["pdftotext", "-layout"];
  if (opts?.first !== undefined) args.push("-f", String(opts.first));
  if (opts?.last !== undefined) args.push("-l", String(opts.last));
  args.push(path, "-");

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`pdftotext failed for ${path}: ${stderr.trim() || stdout.trim()}`);
  }

  return stdout;
}

export interface RenderPdfPagesOptions {
  pages: number[];
  dpi: number;
  outDir: string;
  prefix?: string;
}

/**
 * Render each requested page of a PDF to a PNG via `pdftoppm`.
 * Returns the produced file paths, named `<prefix>-<page>.png` — a stable
 * name regardless of how pdftoppm chose to zero-pad its own output.
 */
export async function renderPdfPages(path: string, opts: RenderPdfPagesOptions): Promise<string[]> {
  await ensureTool("pdftoppm");
  await mkdir(opts.outDir, { recursive: true });

  const prefix = opts.prefix ?? "page";
  const results: string[] = [];

  for (const page of opts.pages) {
    // Unique temp prefix per page so concurrent/previous renders in the same
    // outDir can't collide while we locate pdftoppm's actual output name.
    const tmpBase = `.tmp-${prefix}-${page}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpPrefix = join(opts.outDir, tmpBase);

    const proc = Bun.spawn(
      [
        "pdftoppm",
        "-png",
        "-r",
        String(opts.dpi),
        "-f",
        String(page),
        "-l",
        String(page),
        path,
        tmpPrefix,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`pdftoppm failed for ${path} page ${page}: ${stderr.trim()}`);
    }

    const dirEntries = await readdir(opts.outDir);
    const produced = dirEntries.find((f) => f.startsWith(`${tmpBase}-`) && f.endsWith(".png"));
    if (!produced) {
      throw new Error(`pdftoppm did not produce an output file for page ${page} of ${path}`);
    }

    const stablePath = join(opts.outDir, `${prefix}-${page}.png`);
    await rename(join(opts.outDir, produced), stablePath);
    results.push(stablePath);
  }

  return results;
}
