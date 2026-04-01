import { exists } from "node:fs/promises";
import { join } from "node:path";
import type { BomDatabase, BomEntry } from "../../schemas/bom.js";
import { type KicadComponent, readSchematicComponents } from "../../services/kicad.js";
import { lookupPart, type LcscSearchHit } from "../../services/lcsc.js";
import { findProjectRoot, readBom, readConfig } from "../../services/project.js";

export type IssueSeverity = "error" | "warning" | "info";

export interface BomIssue {
  severity: IssueSeverity;
  entry_id: string;
  entry_role: string;
  refs: string[];
  message: string;
}

export interface BomCheckResult {
  ok: boolean;
  total_entries: number;
  entries_checked: number;
  issues: BomIssue[];
  errors: number;
  warnings: number;
}

export interface BomCheckOptions {
  /** Skip LCSC API calls (only run local checks) */
  offline?: boolean;
  /** Read BOM from jlcpcb/project.db instead of pcbpal.bom.json */
  fromJlcpcb?: boolean;
}

/**
 * Read the JLCPCB KiCad plugin's project.db and convert to a BomDatabase.
 * Groups rows by LCSC part number so each unique part becomes one BOM entry
 * with all its reference designators.
 */
async function readJlcpcbDb(projectDir: string): Promise<BomDatabase> {
  const dbPath = join(projectDir, "jlcpcb", "project.db");
  if (!(await exists(dbPath))) {
    throw new Error(`JLCPCB plugin database not found at ${dbPath}`);
  }

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });

  const rows = db.query(
    "SELECT reference, value, footprint, lcsc, stock, exclude_from_bom FROM part_info",
  ).all() as {
    reference: string;
    value: string;
    footprint: string;
    lcsc: string;
    stock: number | string;
    exclude_from_bom: number;
  }[];

  db.close();

  // Group by LCSC part number
  const byLcsc = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.exclude_from_bom === 1) continue;
    if (!row.lcsc) continue;
    const group = byLcsc.get(row.lcsc) ?? [];
    group.push(row);
    byLcsc.set(row.lcsc, group);
  }

  const now = new Date().toISOString();
  const entries: BomEntry[] = [];

  for (const [lcsc, group] of byLcsc) {
    const first = group[0];
    const refs = group.map((r) => r.reference);
    const stock = typeof first.stock === "number" ? first.stock : parseInt(String(first.stock)) || 0;

    entries.push({
      id: `jlcpcb-${lcsc}`,
      role: `${first.value} (${first.footprint})`,
      category: "other",
      sources: [
        {
          supplier: "lcsc",
          part_number: lcsc,
          stock: stock || undefined,
          last_checked: now,
        },
      ],
      kicad_refs: refs,
      kicad_footprint: first.footprint,
      alternates: [],
      status: "selected",
      added: now,
      updated: now,
    });
  }

  return { schema_version: 1, entries };
}

function issue(
  severity: IssueSeverity,
  entry: BomEntry,
  message: string,
): BomIssue {
  return {
    severity,
    entry_id: entry.id,
    entry_role: entry.role,
    refs: entry.kicad_refs,
    message,
  };
}

/**
 * Normalize a package string for fuzzy comparison.
 * Strips common prefixes/suffixes and lowercases.
 * e.g. "R_0402_1005Metric" → "0402", "0402" → "0402"
 */
function normalizePackage(pkg: string): string {
  let s = pkg.toLowerCase().trim();
  // Strip KiCad footprint library prefix (e.g. "Resistor_SMD:R_0402_1005Metric" → "R_0402_1005Metric")
  const colonIdx = s.indexOf(":");
  if (colonIdx !== -1) s = s.slice(colonIdx + 1);
  // Extract the size code if present (e.g. "R_0402_1005Metric" → "0402")
  const sizeMatch = s.match(/(\d{4})(?:_\d+metric)?/);
  if (sizeMatch) return sizeMatch[1];
  // Strip common prefixes
  s = s.replace(/^(r_|c_|l_|d_|led_)/, "");
  return s;
}

/**
 * Check if an LCSC package is compatible with a KiCad footprint.
 * Returns true if they appear to match, false if definite mismatch, null if can't tell.
 */
function packageMatchesFootprint(
  lcscPackage: string,
  kicadFootprint: string,
): boolean | null {
  if (!lcscPackage || !kicadFootprint) return null;
  const normLcsc = normalizePackage(lcscPackage);
  const normKicad = normalizePackage(kicadFootprint);
  if (normLcsc === normKicad) return true;
  // Check if one contains the other
  if (normKicad.includes(normLcsc) || normLcsc.includes(normKicad)) return true;
  return false;
}

/** Run local-only checks that don't need API calls. */
function checkLocal(
  bom: BomDatabase,
  schMap: Map<string, KicadComponent>,
): BomIssue[] {
  const issues: BomIssue[] = [];

  for (const entry of bom.entries) {
    // No LCSC source
    const lcscSource = entry.sources.find((s) => s.supplier === "lcsc");
    if (!lcscSource && entry.sources.length === 0) {
      issues.push(issue("warning", entry, "No supplier source assigned"));
    }

    // No KiCad refs linked
    if (entry.kicad_refs.length === 0) {
      issues.push(issue("warning", entry, "No KiCad reference designators linked"));
    }

    // Still candidate status
    if (entry.status === "candidate") {
      issues.push(issue("info", entry, "Still in 'candidate' status"));
    }

    // Has LCSC source but recorded stock is 0
    if (lcscSource && lcscSource.stock !== undefined && lcscSource.stock === 0) {
      issues.push(issue("warning", entry, `Recorded stock is 0 for ${lcscSource.part_number} (may be stale — run without --offline to refresh)`));
    }

    // Check that linked refs actually exist in the schematic
    if (schMap.size > 0) {
      for (const ref of entry.kicad_refs) {
        if (!schMap.has(ref)) {
          issues.push(issue("warning", entry, `Reference ${ref} not found in KiCad schematic`));
        }
      }

      // Check footprint consistency across refs for this entry
      const footprints = new Set<string>();
      for (const ref of entry.kicad_refs) {
        const comp = schMap.get(ref);
        if (comp?.footprint) footprints.add(comp.footprint);
      }
      if (footprints.size > 1) {
        issues.push(
          issue("warning", entry, `Refs have different footprints: ${[...footprints].join(", ")}`),
        );
      }
    }
  }

  // Check for duplicate refs across entries
  const refMap = new Map<string, BomEntry[]>();
  for (const entry of bom.entries) {
    for (const ref of entry.kicad_refs) {
      const existing = refMap.get(ref) ?? [];
      existing.push(entry);
      refMap.set(ref, existing);
    }
  }
  for (const [ref, entries] of refMap) {
    if (entries.length > 1) {
      for (const entry of entries) {
        issues.push(
          issue("error", entry, `Reference ${ref} is assigned to ${entries.length} BOM entries`),
        );
      }
    }
  }

  return issues;
}

/**
 * Get the footprint for a BOM entry from schematic data.
 * Uses the first ref's footprint (they should all match — inconsistency is flagged separately).
 */
function getSchematicFootprint(
  entry: BomEntry,
  schMap: Map<string, KicadComponent>,
): string | null {
  for (const ref of entry.kicad_refs) {
    const comp = schMap.get(ref);
    if (comp?.footprint) return comp.footprint;
  }
  return null;
}

/** Run online checks that verify parts against the LCSC API. */
async function checkOnline(
  bom: BomDatabase,
  schMap: Map<string, KicadComponent>,
  onProgress?: (checked: number, total: number) => void,
): Promise<BomIssue[]> {
  const issues: BomIssue[] = [];

  // Collect entries with LCSC sources
  const lcscEntries: { entry: BomEntry; partNumber: string }[] = [];
  for (const entry of bom.entries) {
    const lcscSource = entry.sources.find((s) => s.supplier === "lcsc");
    if (lcscSource) {
      lcscEntries.push({ entry, partNumber: lcscSource.part_number });
    }
  }

  // Deduplicate API calls (same LCSC part used by multiple entries)
  const uniqueParts = [...new Set(lcscEntries.map((e) => e.partNumber))];
  const lookupCache = new Map<string, LcscSearchHit | null>();

  let checked = 0;
  for (const partNumber of uniqueParts) {
    try {
      const hit = await lookupPart(partNumber);
      lookupCache.set(partNumber, hit);
    } catch {
      lookupCache.set(partNumber, null);
    }
    checked++;
    onProgress?.(checked, uniqueParts.length);
  }

  // Now check each entry against its lookup result
  for (const { entry, partNumber } of lcscEntries) {
    const hit = lookupCache.get(partNumber);

    if (!hit) {
      issues.push(issue("error", entry, `LCSC part ${partNumber} not found or API error`));
      continue;
    }

    // Stock check
    if (hit.stock === 0) {
      issues.push(issue("error", entry, `${partNumber} is out of stock on LCSC`));
    } else if (hit.stock < 100) {
      issues.push(issue("warning", entry, `${partNumber} has low stock: ${hit.stock}`));
    }

    // Package vs footprint check — use schematic footprint if available
    const schFootprint = getSchematicFootprint(entry, schMap);
    const footprintToCheck = entry.kicad_footprint || schFootprint;
    if (footprintToCheck) {
      const match = packageMatchesFootprint(hit.package, footprintToCheck);
      if (match === false) {
        issues.push(
          issue(
            "warning",
            entry,
            `Package may not match footprint: LCSC says "${hit.package}", KiCad has "${footprintToCheck}"`,
          ),
        );
      }
    }

    // Library type info
    if (hit.library_type === "extended") {
      issues.push(
        issue("info", entry, `${partNumber} is an extended part (higher JLCPCB assembly fee)`),
      );
    }
  }

  return issues;
}

export async function bomCheck(
  opts: BomCheckOptions = {},
  onProgress?: (checked: number, total: number) => void,
): Promise<BomCheckResult> {
  const root = await findProjectRoot();
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }

  let bom: BomDatabase;

  if (opts.fromJlcpcb) {
    bom = await readJlcpcbDb(root);
  } else {
    bom = await readBom(root);

    // Auto-detect: if pcbpal BOM is empty but jlcpcb/project.db exists, use that
    if (bom.entries.length === 0) {
      const jlcpcbDb = join(root, "jlcpcb", "project.db");
      if (await exists(jlcpcbDb)) {
        bom = await readJlcpcbDb(root);
      }
    }
  }

  if (bom.entries.length === 0) {
    return {
      ok: true,
      total_entries: 0,
      entries_checked: 0,
      issues: [],
      errors: 0,
      warnings: 0,
    };
  }

  // Read schematic components for footprint cross-referencing
  const schMap = new Map<string, KicadComponent>();
  try {
    const config = await readConfig(root);
    if (config.project.kicad_project) {
      const components = await readSchematicComponents(root);
      for (const comp of components) {
        schMap.set(comp.ref, comp);
      }
    }
  } catch {
    // No KiCad project configured or schematic unreadable — skip schematic checks
  }

  const issues = checkLocal(bom, schMap);

  let entriesChecked = 0;
  if (!opts.offline) {
    const onlineIssues = await checkOnline(bom, schMap, onProgress);
    issues.push(...onlineIssues);
    entriesChecked = bom.entries.filter((e) =>
      e.sources.some((s) => s.supplier === "lcsc"),
    ).length;
  }

  // Deduplicate (duplicate-ref issues may appear twice)
  const seen = new Set<string>();
  const deduped = issues.filter((i) => {
    const key = `${i.entry_id}:${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const errors = deduped.filter((i) => i.severity === "error").length;
  const warnings = deduped.filter((i) => i.severity === "warning").length;

  return {
    ok: errors === 0,
    total_entries: bom.entries.length,
    entries_checked: opts.offline ? 0 : entriesChecked,
    issues: deduped,
    errors,
    warnings,
  };
}
