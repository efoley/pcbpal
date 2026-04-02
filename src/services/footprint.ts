import { exists, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * A pad extracted from a .kicad_mod file.
 */
export interface FootprintPad {
  number: string;
  type: "smd" | "thru_hole";
  shape: string; // roundrect, rect, circle, oval
  x: number; // mm, relative to footprint origin
  y: number;
  width: number; // mm
  height: number;
  drill?: number; // mm, for thru-hole
  rotation?: number;
}

/**
 * Parsed footprint geometry extracted from a .kicad_mod file.
 */
export interface FootprintGeometry {
  name: string;
  pads: FootprintPad[];
  /** Bounding box of all pads (mm). */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Courtyard rectangle if present (mm). */
  courtyard?: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * Parse pads from a .kicad_mod file content string.
 */
export function parseKicadMod(content: string): FootprintGeometry {
  // Extract footprint name
  const nameMatch = content.match(/\((?:footprint|module)\s+"([^"]+)"/);
  const name = nameMatch?.[1] ?? "unknown";

  const pads: FootprintPad[] = [];

  // Extract pad blocks by finding "(pad " and scanning forward with paren counting.
  // Handles both multi-line KiCad standard and single-line easyeda2kicad formats.
  const padStarts: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = content.indexOf("(pad ", searchFrom);
    if (idx === -1) break;
    padStarts.push(idx);
    searchFrom = idx + 5;
  }

  for (const start of padStarts) {
    let depth = 0;
    let end = start;
    for (let i = start; i < content.length; i++) {
      if (content[i] === "(") depth++;
      else if (content[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const flat = content.slice(start, end).replace(/\n\s*/g, " ");
    const lineMatch = flat.match(
      /\(pad\s+"?(\w+)"?\s+(smd|thru_hole)\s+(\w+)\s+(.+)/,
    );
    if (!lineMatch) continue;
    const [, num, type, shape, body] = lineMatch;

    const atMatch = body.match(/\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)/);
    const sizeMatch = body.match(/\(size\s+([-\d.]+)\s+([-\d.]+)\)/);
    const drillMatch = body.match(/\(drill\s+([-\d.]+)/);

    if (!atMatch || !sizeMatch) continue;

    pads.push({
      number: num,
      type: type as "smd" | "thru_hole",
      shape,
      x: parseFloat(atMatch[1]),
      y: parseFloat(atMatch[2]),
      width: parseFloat(sizeMatch[1]),
      height: parseFloat(sizeMatch[2]),
      rotation: atMatch[3] ? parseFloat(atMatch[3]) : undefined,
      drill: drillMatch ? parseFloat(drillMatch[1]) : undefined,
    });
  }

  // Compute bounding box from pads
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pad of pads) {
    const halfW = pad.width / 2;
    const halfH = pad.height / 2;
    minX = Math.min(minX, pad.x - halfW);
    minY = Math.min(minY, pad.y - halfH);
    maxX = Math.max(maxX, pad.x + halfW);
    maxY = Math.max(maxY, pad.y + halfH);
  }

  // Extract courtyard from fp_rect on F.CrtYd layer
  let courtyard: FootprintGeometry["courtyard"];
  const crtydMatch = content.match(
    /\(fp_rect\s*\n?\s*\(start\s+([-\d.]+)\s+([-\d.]+)\)\s*\n?\s*\(end\s+([-\d.]+)\s+([-\d.]+)\)[\s\S]*?F\.CrtYd/,
  );
  if (crtydMatch) {
    courtyard = {
      minX: parseFloat(crtydMatch[1]),
      minY: parseFloat(crtydMatch[2]),
      maxX: parseFloat(crtydMatch[3]),
      maxY: parseFloat(crtydMatch[4]),
    };
  }

  return {
    name,
    pads,
    bbox:
      pads.length > 0
        ? { minX, minY, maxX, maxY }
        : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    courtyard,
  };
}

/**
 * Result of comparing two footprint geometries.
 */
export interface FootprintComparison {
  padCountMatch: boolean;
  kicadPadCount: number;
  lcscPadCount: number;
  bboxSimilar: boolean;
  kicadBbox: FootprintGeometry["bbox"];
  lcscBbox: FootprintGeometry["bbox"];
  /** Per-pad comparison, matched by pad number. */
  padIssues: string[];
  /** Overall assessment. */
  summary: "match" | "likely_match" | "mismatch" | "unclear";
}

/**
 * Compare two footprint geometries and report differences.
 */
export function compareFootprints(
  kicad: FootprintGeometry,
  lcsc: FootprintGeometry,
): FootprintComparison {
  const padCountMatch = kicad.pads.length === lcsc.pads.length;
  const padIssues: string[] = [];

  // Bounding box comparison — allow 20% tolerance
  const kicadW = kicad.bbox.maxX - kicad.bbox.minX;
  const kicadH = kicad.bbox.maxY - kicad.bbox.minY;
  const lcscW = lcsc.bbox.maxX - lcsc.bbox.minX;
  const lcscH = lcsc.bbox.maxY - lcsc.bbox.minY;

  const wRatio = kicadW > 0 && lcscW > 0 ? Math.max(kicadW, lcscW) / Math.min(kicadW, lcscW) : 999;
  const hRatio = kicadH > 0 && lcscH > 0 ? Math.max(kicadH, lcscH) / Math.min(kicadH, lcscH) : 999;
  const bboxSimilar = wRatio < 1.2 && hRatio < 1.2;

  if (!padCountMatch) {
    padIssues.push(
      `Pad count: KiCad has ${kicad.pads.length}, LCSC has ${lcsc.pads.length}`,
    );
  }

  if (!bboxSimilar) {
    padIssues.push(
      `Bounding box: KiCad is ${kicadW.toFixed(2)}x${kicadH.toFixed(2)}mm, LCSC is ${lcscW.toFixed(2)}x${lcscH.toFixed(2)}mm`,
    );
  }

  // Per-pad comparison (match by pad number)
  if (padCountMatch) {
    const kicadByNum = new Map(kicad.pads.map((p) => [p.number, p]));
    const lcscByNum = new Map(lcsc.pads.map((p) => [p.number, p]));

    for (const [num, kPad] of kicadByNum) {
      const lPad = lcscByNum.get(num);
      if (!lPad) {
        padIssues.push(`Pad ${num}: exists in KiCad but not in LCSC footprint`);
        continue;
      }

      // Position comparison (tolerance 0.15mm)
      const dx = Math.abs(kPad.x - lPad.x);
      const dy = Math.abs(kPad.y - lPad.y);
      if (dx > 0.15 || dy > 0.15) {
        padIssues.push(
          `Pad ${num} position: KiCad (${kPad.x.toFixed(2)}, ${kPad.y.toFixed(2)}) vs LCSC (${lPad.x.toFixed(2)}, ${lPad.y.toFixed(2)}) — delta ${dx.toFixed(2)}, ${dy.toFixed(2)}mm`,
        );
      }

      // Size comparison (tolerance 20%)
      const wRatio =
        Math.max(kPad.width, lPad.width) / Math.min(kPad.width, lPad.width);
      const hRatio =
        Math.max(kPad.height, lPad.height) /
        Math.min(kPad.height, lPad.height);
      if (wRatio > 1.3 || hRatio > 1.3) {
        padIssues.push(
          `Pad ${num} size: KiCad ${kPad.width.toFixed(2)}x${kPad.height.toFixed(2)}mm vs LCSC ${lPad.width.toFixed(2)}x${lPad.height.toFixed(2)}mm`,
        );
      }
    }
  }

  // Overall assessment
  let summary: FootprintComparison["summary"];
  if (padCountMatch && bboxSimilar && padIssues.length === 0) {
    summary = "match";
  } else if (padCountMatch && padIssues.length <= 2) {
    summary = "likely_match";
  } else if (!padCountMatch) {
    summary = "mismatch";
  } else {
    summary = "unclear";
  }

  return {
    padCountMatch,
    kicadPadCount: kicad.pads.length,
    lcscPadCount: lcsc.pads.length,
    bboxSimilar,
    kicadBbox: kicad.bbox,
    lcscBbox: lcsc.bbox,
    padIssues,
    summary,
  };
}

/**
 * Detect the likely rotation offset (in degrees) between two footprints.
 * Tries 0, 90, 180, 270 degree rotations of the LCSC footprint and picks
 * the one that best aligns the pads to the KiCad footprint.
 * Returns the rotation to apply to the LCSC footprint to match KiCad, or null if unclear.
 */
export function detectRotationOffset(
  kicad: FootprintGeometry,
  lcsc: FootprintGeometry,
): number | null {
  if (kicad.pads.length === 0 || lcsc.pads.length === 0) return null;
  if (kicad.pads.length !== lcsc.pads.length) return null;

  // For each candidate rotation, rotate all LCSC pads and compute
  // the total position error when matched by pad number.
  const kicadByNum = new Map(kicad.pads.map((p) => [p.number, p]));
  const candidates = [0, 90, 180, 270];
  let bestRotation = 0;
  let bestError = Infinity;

  for (const deg of candidates) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.round(Math.cos(rad));
    const sin = Math.round(Math.sin(rad));
    let totalError = 0;
    let matched = 0;

    for (const lPad of lcsc.pads) {
      const kPad = kicadByNum.get(lPad.number);
      if (!kPad) continue;

      // Rotate LCSC pad position
      const rx = lPad.x * cos - lPad.y * sin;
      const ry = lPad.x * sin + lPad.y * cos;

      const dx = Math.abs(rx - kPad.x);
      const dy = Math.abs(ry - kPad.y);
      totalError += dx + dy;
      matched++;
    }

    if (matched > 0 && totalError / matched < bestError) {
      bestError = totalError / matched;
      bestRotation = deg;
    }
  }

  // If best average error per pad is under 0.5mm, we're confident.
  // Different libraries use slightly different land patterns for the same package,
  // so we allow some tolerance (e.g. SOT-23 pads at 0.94mm vs 1.24mm from center).
  if (bestError < 0.5) return bestRotation;
  return null;
}

/**
 * Resolve a KiCad footprint library reference (e.g. "Resistor_SMD:R_0603_1608Metric")
 * to an absolute .kicad_mod file path.
 */
export async function resolveFootprintPath(
  libraryRef: string,
  extraLibDirs?: string[],
): Promise<string | null> {
  const [lib, name] = libraryRef.split(":");
  if (!lib || !name) return null;

  const searchDirs = [
    "/usr/share/kicad/footprints",
    ...(extraLibDirs ?? []),
  ];

  for (const dir of searchDirs) {
    const modPath = join(dir, `${lib}.pretty`, `${name}.kicad_mod`);
    if (await exists(modPath)) return modPath;
  }

  return null;
}

/**
 * Read and parse a .kicad_mod file.
 */
export async function readFootprint(path: string): Promise<FootprintGeometry> {
  const content = await readFile(path, "utf-8");
  return parseKicadMod(content);
}

/**
 * Render a footprint to SVG using kicad-cli.
 * Returns the path to the generated SVG, or null if kicad-cli is unavailable.
 */
export async function renderFootprintSvg(
  prettyDir: string,
  footprintName: string,
  outputDir: string,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      [
        "kicad-cli",
        "fp",
        "export",
        "svg",
        prettyDir,
        "--footprint",
        footprintName,
        "--output",
        outputDir,
        "--layers",
        "F.Cu,F.Paste,F.SilkS,F.Mask,F.CrtYd,F.Fab",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    // kicad-cli names the output file after the footprint
    const svgPath = join(outputDir, `${footprintName}.svg`);
    if (await exists(svgPath)) return svgPath;

    // Sometimes it uses different naming — find any SVG in outputDir
    const files = await readdir(outputDir);
    const svg = files.find((f) => f.endsWith(".svg"));
    return svg ? join(outputDir, svg) : null;
  } catch {
    return null;
  }
}
