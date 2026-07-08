/**
 * Thin wrapper around rsvg-convert (from librsvg) — used to turn the
 * SVGs `kicad-cli` exports into PNGs for LLM vision APIs that handle
 * SVG poorly or not at all.
 */

// Cached across calls in this module — the toolchain doesn't change
// mid-process, and probing the binary on every call is wasteful.
let cachedAvailable: boolean | null = null;

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
 * Detect whether `rsvg-convert` is on PATH. Result is cached for the
 * lifetime of the process; pass `force: true` to re-probe.
 */
export async function svgToolAvailable(opts?: { force?: boolean }): Promise<boolean> {
  if (cachedAvailable !== null && !opts?.force) {
    return cachedAvailable;
  }
  cachedAvailable = await checkTool("rsvg-convert");
  return cachedAvailable;
}

export interface SvgToPngOptions {
  /** Output resolution in dots per inch. Defaults to 150. */
  dpi?: number;
}

/**
 * Convert an SVG file to a PNG alongside it via `rsvg-convert`. The PNG
 * is written at the same path with its extension swapped to `.png`.
 * Returns the produced PNG path.
 */
export async function svgToPng(svgPath: string, opts?: SvgToPngOptions): Promise<string> {
  const dpi = opts?.dpi ?? 150;
  const pngPath = svgPath.replace(/\.svg$/i, ".png");

  const proc = Bun.spawn(
    ["rsvg-convert", "--dpi-x", String(dpi), "--dpi-y", String(dpi), "-o", pngPath, svgPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`rsvg-convert failed for ${svgPath}: ${stderr.trim()}`);
  }

  return pngPath;
}
