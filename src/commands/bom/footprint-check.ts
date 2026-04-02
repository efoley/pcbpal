import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BomDatabase, BomEntry } from "../../schemas/bom.js";
import {
  type FootprintComparison,
  type FootprintGeometry,
  compareFootprints,
  readFootprint,
  renderFootprintSvg,
  resolveFootprintPath,
} from "../../services/footprint.js";
import { type KicadComponent, readSchematicComponents } from "../../services/kicad.js";
import { checkEasyeda2kicad, libFetch } from "../lib/core.js";
import { findProjectRoot, readBom, readConfig } from "../../services/project.js";

export interface FpCheckEntry {
  ref: string;
  value: string;
  lcsc: string | null;
  kicadFootprint: string;
  kicadGeometry: FootprintGeometry | null;
  lcscGeometry: FootprintGeometry | null;
  comparison: FootprintComparison | null;
  kicadSvg: string | null;
  lcscSvg: string | null;
  error: string | null;
}

export interface FpCheckResult {
  ok: boolean;
  entries: FpCheckEntry[];
  matches: number;
  likelyMatches: number;
  mismatches: number;
  errors: number;
}

export interface FpCheckOptions {
  /** Only check specific refs. */
  refs?: string[];
  /** Skip SVG rendering. */
  noRender?: boolean;
  /** Read BOM from jlcpcb/project.db. */
  fromJlcpcb?: boolean;
}

/**
 * Build a ref→LCSC mapping from BOM data.
 * Each ref gets the LCSC part number from its BOM entry.
 */
function buildRefToLcsc(bom: BomDatabase): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of bom.entries) {
    const lcscSource = entry.sources.find((s) => s.supplier === "lcsc");
    if (!lcscSource) continue;
    for (const ref of entry.kicad_refs) {
      map.set(ref, lcscSource.part_number);
    }
  }
  return map;
}

export async function footprintCheck(
  opts: FpCheckOptions = {},
  onProgress?: (msg: string) => void,
): Promise<FpCheckResult> {
  const root = await findProjectRoot();
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }

  // Read schematic components
  const schComponents = await readSchematicComponents(root);
  if (schComponents.length === 0) {
    throw new Error("No components found in KiCad schematics");
  }

  // Read BOM for LCSC mappings
  let bom: BomDatabase;
  if (opts.fromJlcpcb) {
    // Import dynamically to avoid circular deps at module level
    const { readJlcpcbDb } = await import("./check.js");
    bom = await readJlcpcbDb(root);
  } else {
    bom = await readBom(root);
  }
  const refToLcsc = buildRefToLcsc(bom);

  // Filter to requested refs, or all refs that have both footprint + LCSC
  let components = schComponents.filter(
    (c) => c.footprint && refToLcsc.has(c.ref),
  );
  if (opts.refs) {
    const requested = new Set(opts.refs);
    components = components.filter((c) => requested.has(c.ref));
  }

  if (components.length === 0) {
    throw new Error(
      "No components with both a KiCad footprint and LCSC part number found",
    );
  }

  // Check if easyeda2kicad is available (needed for LCSC footprint fetching)
  const e2kCheck = await checkEasyeda2kicad();
  const canFetchLcsc = e2kCheck.ok;

  // Deduplicate LCSC fetches and KiCad footprint resolves
  const lcscFootprintCache = new Map<string, FootprintGeometry | null>();
  const kicadFootprintCache = new Map<string, FootprintGeometry | null>();

  const outputDir = join(root, ".pcbpal", "footprint-check");
  await mkdir(outputDir, { recursive: true });

  const extraLibDirs = [
    join(root, ".pcbpal", "lib"),
    join(root, ".pcbpal", "kicad-libs"),
  ];

  const entries: FpCheckEntry[] = [];

  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    const lcsc = refToLcsc.get(comp.ref) ?? null;
    onProgress?.(`[${i + 1}/${components.length}] ${comp.ref} (${comp.footprint})`);

    const entry: FpCheckEntry = {
      ref: comp.ref,
      value: comp.value,
      lcsc,
      kicadFootprint: comp.footprint,
      kicadGeometry: null,
      lcscGeometry: null,
      comparison: null,
      kicadSvg: null,
      lcscSvg: null,
      error: null,
    };

    // Resolve and parse the KiCad footprint
    if (!kicadFootprintCache.has(comp.footprint)) {
      try {
        const kicadPath = await resolveFootprintPath(comp.footprint, extraLibDirs);
        if (kicadPath) {
          kicadFootprintCache.set(comp.footprint, await readFootprint(kicadPath));
        } else {
          kicadFootprintCache.set(comp.footprint, null);
        }
      } catch {
        kicadFootprintCache.set(comp.footprint, null);
      }
    }
    entry.kicadGeometry = kicadFootprintCache.get(comp.footprint) ?? null;

    // Fetch and parse the LCSC footprint
    if (lcsc && canFetchLcsc) {
      if (!lcscFootprintCache.has(lcsc)) {
        // Try fetching via easyeda2kicad, but also check for cached files
        try {
          await libFetch({ lcsc, footprint: true });
        } catch {
          // May fail if already cached (easyeda2kicad returns error without --overwrite)
        }
        // Read from cache regardless of whether fetch succeeded
        try {
          const { readdir } = await import("node:fs/promises");
          const prettyDir = join(root, ".pcbpal", "lib", `${lcsc}.pretty`);
          const files = await readdir(prettyDir).catch(() => []);
          const modFile = files.find((f) => f.endsWith(".kicad_mod"));
          if (modFile) {
            lcscFootprintCache.set(lcsc, await readFootprint(join(prettyDir, modFile)));
          } else {
            lcscFootprintCache.set(lcsc, null);
          }
        } catch {
          lcscFootprintCache.set(lcsc, null);
        }
      }
      entry.lcscGeometry = lcscFootprintCache.get(lcsc!) ?? null;
    }

    // Compare
    if (entry.kicadGeometry && entry.lcscGeometry) {
      entry.comparison = compareFootprints(entry.kicadGeometry, entry.lcscGeometry);
    } else if (!entry.kicadGeometry) {
      entry.error = `Could not find KiCad footprint: ${comp.footprint}`;
    } else if (!entry.lcscGeometry && lcsc) {
      entry.error = `Could not fetch LCSC footprint for ${lcsc}`;
    }

    // Render SVGs for mismatches and unclear results
    if (!opts.noRender && entry.comparison) {
      const shouldRender =
        entry.comparison.summary === "mismatch" ||
        entry.comparison.summary === "unclear" ||
        entry.comparison.padIssues.length > 0;

      if (shouldRender) {
        const svgDir = join(outputDir, comp.ref);
        await mkdir(svgDir, { recursive: true });

        // Render KiCad footprint
        if (entry.kicadGeometry) {
          const [lib, fpName] = comp.footprint.split(":");
          if (lib && fpName) {
            const kicadPath = await resolveFootprintPath(comp.footprint, extraLibDirs);
            if (kicadPath) {
              entry.kicadSvg = await renderFootprintSvg(
                dirname(kicadPath),
                fpName,
                svgDir,
              );
              // Rename to disambiguate
              if (entry.kicadSvg) {
                const { rename } = await import("node:fs/promises");
                const newPath = join(svgDir, `kicad-${fpName}.svg`);
                await rename(entry.kicadSvg, newPath).catch(() => {});
                entry.kicadSvg = newPath;
              }
            }
          }
        }

        // Render LCSC footprint
        if (entry.lcscGeometry && lcsc) {
          const prettyDir = join(root, ".pcbpal", "lib", `${lcsc}.pretty`);
          const { readdir: rd } = await import("node:fs/promises");
          const files = await rd(prettyDir).catch(() => []);
          const modFile = files.find((f) => f.endsWith(".kicad_mod"));
          if (modFile) {
            const fpName = modFile.replace(".kicad_mod", "");
            entry.lcscSvg = await renderFootprintSvg(prettyDir, fpName, svgDir);
            if (entry.lcscSvg) {
              const { rename } = await import("node:fs/promises");
              const newPath = join(svgDir, `lcsc-${fpName}.svg`);
              await rename(entry.lcscSvg, newPath).catch(() => {});
              entry.lcscSvg = newPath;
            }
          }
        }
      }
    }

    entries.push(entry);
  }

  const matches = entries.filter((e) => e.comparison?.summary === "match").length;
  const likelyMatches = entries.filter((e) => e.comparison?.summary === "likely_match").length;
  const mismatches = entries.filter((e) => e.comparison?.summary === "mismatch").length;
  const errors = entries.filter((e) => e.error || !e.comparison).length;

  return {
    ok: mismatches === 0,
    entries,
    matches,
    likelyMatches,
    mismatches,
    errors,
  };
}
