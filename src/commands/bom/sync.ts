import { exists } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BomCategory, BomDatabase, BomEntry } from "../../schemas/bom.js";
import { type KicadComponent, readSchematicComponents } from "../../services/kicad.js";
import { lookupPart } from "../../services/lcsc.js";
import { findProjectRoot, readBom, readConfig, writeBom } from "../../services/project.js";

export interface SyncResult {
  ok: true;
  added: SyncAddedEntry[];
  updated: SyncUpdatedEntry[];
  orphaned: SyncOrphanedEntry[];
  unchanged: number;
  schematicComponents: number;
}

export interface SyncAddedEntry {
  id: string;
  role: string;
  category: BomCategory;
  refs: string[];
  lcsc: string | null;
}

export interface SyncUpdatedEntry {
  id: string;
  role: string;
  refsAdded: string[];
  refsRemoved: string[];
}

export interface SyncOrphanedEntry {
  id: string;
  role: string;
  refs: string[];
}

export interface SyncOptions {
  /** Don't write changes, just report what would happen. */
  dryRun?: boolean;
  /** Fetch part details from LCSC API for new entries. */
  online?: boolean;
}

/**
 * Group schematic components by (value, footprint) — these represent
 * the same physical part used in multiple places.
 */
function groupComponents(
  components: KicadComponent[],
): Map<string, KicadComponent[]> {
  const groups = new Map<string, KicadComponent[]>();
  for (const comp of components) {
    // Skip components with no footprint (power symbols, etc.)
    if (!comp.footprint) continue;
    const key = `${comp.value}\0${comp.footprint}`;
    const group = groups.get(key) ?? [];
    group.push(comp);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Infer BOM category from the KiCad library ID.
 */
function inferCategory(libId: string, ref: string): BomCategory {
  const lib = libId.toLowerCase();
  if (lib.startsWith("device:r") || ref.startsWith("R")) return "passive";
  if (lib.startsWith("device:c") || ref.startsWith("C")) return "passive";
  if (lib.startsWith("device:l") || ref.startsWith("L")) return "passive";
  if (lib.includes("inductor") || ref.startsWith("FB")) return "inductor";
  if (lib.includes("diode") || ref.startsWith("D")) return "diode";
  if (lib.includes("led") || lib.includes("device:led")) return "led";
  if (lib.includes("transistor") || ref.startsWith("Q")) return "transistor";
  if (lib.includes("connector") || ref.startsWith("J")) return "connector";
  if (lib.includes("crystal") || ref.startsWith("Y")) return "crystal";
  if (lib.includes("sensor")) return "sensor";
  if (lib.includes("regulator") || lib.includes("power")) return "power";
  if (lib.includes("antenna")) return "antenna";
  if (ref.startsWith("U")) return "ic";
  return "other";
}

/**
 * Build a role string from component data.
 */
function buildRole(comp: KicadComponent): string {
  if (comp.description && comp.description !== "~") {
    return comp.description;
  }
  if (comp.value && comp.footprint) {
    // Extract package from footprint (e.g. "Resistor_SMD:R_0603_1608Metric" → "0603")
    const pkgMatch = comp.footprint.match(/(\d{4})(?:_\d+[Mm]etric)?/);
    const pkg = pkgMatch ? pkgMatch[1] : "";
    return pkg ? `${comp.value} (${pkg})` : comp.value;
  }
  return comp.value || comp.ref;
}

/**
 * Read the JLCPCB plugin DB to get ref→LCSC mappings.
 */
async function readJlcpcbMappings(
  projectDir: string,
): Promise<Map<string, string>> {
  const dbPath = join(projectDir, "jlcpcb", "project.db");
  if (!(await exists(dbPath))) return new Map();

  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .query("SELECT reference, lcsc FROM part_info WHERE lcsc IS NOT NULL AND lcsc != ''")
    .all() as { reference: string; lcsc: string }[];
  db.close();

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.reference, row.lcsc);
  }
  return map;
}

/**
 * One (value, footprint) group of schematic components and the existing BOM
 * entries that already reference any of its refs.
 */
export interface MatchedGroup {
  /** `${value}\0${footprint}` grouping key. */
  key: string;
  /** Sorted reference designators in this group (e.g. ["R1","R2","R3"]). */
  refs: string[];
  /** Representative component (group[0]) — carries value/libId/datasheet. */
  sample: KicadComponent;
  /** The group's footprint. */
  footprint: string;
  /** Distinct ids of existing BOM entries sharing a ref with this group. */
  entryIds: string[];
}

/**
 * Pure schematic↔BOM correspondence produced by {@link matchSchematicToBom}.
 * `bomSync` applies this plan (adding, updating, orphaning entries); the eval
 * harness (evals/bom-sync) scores it against golden correspondences. Keeping
 * the matching a pure function is what makes it testable and CI-able offline.
 */
export interface SchBomMatch {
  /** Clean, footprint-consistent matches: schematic ref → BOM entry id. */
  refToEntry: Record<string, string>;
  /** Schematic refs that resolve to no existing entry (would be added). */
  unmatchedSchRefs: string[];
  /** Refs matched by ref but whose schematic footprint disagrees with the entry. */
  footprintMismatches: string[];
  /** Refs whose group spans more than one existing entry (ambiguous). */
  ambiguousRefs: string[];
  /** Ids of existing entries with no live schematic ref. */
  orphanedEntryIds: string[];
  /** Per-group breakdown consumed by bomSync when applying the plan. */
  groups: MatchedGroup[];
}

/**
 * Decide how each schematic component maps onto the BOM — with no I/O, no
 * mutation, no network. Matching semantics (identical to what bomSync acts on):
 *  - Schematic components are grouped by (value, footprint); footprint-less
 *    components (power symbols etc.) are dropped, exactly as `groupComponents`.
 *  - A group resolves to the set of existing BOM entries that already list any
 *    of the group's refs in `kicad_refs`.
 *  - size 1 → the group's refs belong to that entry. If the entry records a
 *    conflicting `kicad_footprint`, the refs are reported as
 *    `footprintMismatches` rather than clean `refToEntry` matches (bomSync still
 *    updates the entry — this only surfaces the disagreement for evals).
 *  - size 0 → the group's refs are unmatched (bomSync would add a new entry).
 *  - size >1 → ambiguous; bomSync leaves it for manual resolution.
 *  - Any existing entry whose every ref is absent from the schematic is orphaned.
 */
export function matchSchematicToBom(
  schComponents: KicadComponent[],
  bomEntries: BomEntry[],
): SchBomMatch {
  const groupMap = groupComponents(schComponents);

  // ref → entry id, from the BOM's recorded kicad_refs.
  const bomRefToEntryId = new Map<string, string>();
  const entryById = new Map<string, BomEntry>();
  for (const entry of bomEntries) {
    entryById.set(entry.id, entry);
    for (const ref of entry.kicad_refs) bomRefToEntryId.set(ref, entry.id);
  }

  const schRefs = new Set(schComponents.map((c) => c.ref));

  const refToEntry: Record<string, string> = {};
  const unmatchedSchRefs: string[] = [];
  const footprintMismatches: string[] = [];
  const ambiguousRefs: string[] = [];
  const groups: MatchedGroup[] = [];

  for (const [key, group] of groupMap) {
    const refs = group.map((c) => c.ref).sort();
    const sample = group[0];
    const entryIds = [
      ...new Set(refs.map((r) => bomRefToEntryId.get(r)).filter((id): id is string => !!id)),
    ];
    groups.push({ key, refs, sample, footprint: sample.footprint, entryIds });

    if (entryIds.length === 1) {
      const entry = entryById.get(entryIds[0]);
      const conflict = !!entry?.kicad_footprint && entry.kicad_footprint !== sample.footprint;
      for (const ref of refs) {
        if (conflict) footprintMismatches.push(ref);
        else refToEntry[ref] = entryIds[0];
      }
    } else if (entryIds.length === 0) {
      unmatchedSchRefs.push(...refs);
    } else {
      ambiguousRefs.push(...refs);
    }
  }

  const orphanedEntryIds: string[] = [];
  for (const entry of bomEntries) {
    const deadRefs = entry.kicad_refs.filter((r) => !schRefs.has(r));
    if (deadRefs.length > 0 && deadRefs.length === entry.kicad_refs.length) {
      orphanedEntryIds.push(entry.id);
    }
  }

  return {
    refToEntry,
    unmatchedSchRefs: unmatchedSchRefs.sort(),
    footprintMismatches: footprintMismatches.sort(),
    ambiguousRefs: ambiguousRefs.sort(),
    orphanedEntryIds,
    groups,
  };
}

export async function bomSync(
  opts: SyncOptions = {},
  onProgress?: (msg: string) => void,
): Promise<SyncResult> {
  const root = await findProjectRoot();
  if (!root) throw new Error("Not in a pcbpal project (no pcbpal.toml found)");

  const config = await readConfig(root);
  if (!config.project.kicad_project) {
    throw new Error("No kicad_project configured in pcbpal.toml");
  }

  const bom = await readBom(root);
  const schComponents = await readSchematicComponents(root);

  if (schComponents.length === 0) {
    throw new Error("No components found in KiCad schematics");
  }

  // Try to get LCSC mappings from JLCPCB plugin DB
  const jlcpcbMap = await readJlcpcbMappings(root);

  // Pure matching plan: which schematic groups map onto which BOM entries.
  const match = matchSchematicToBom(schComponents, bom.entries);
  const entryById = new Map(bom.entries.map((e) => [e.id, e]));

  // All refs in the schematic
  const schRefs = new Set(schComponents.map((c) => c.ref));

  const added: SyncAddedEntry[] = [];
  const updated: SyncUpdatedEntry[] = [];
  const now = new Date().toISOString();

  // For each group of components, find or create a BOM entry
  for (const grp of match.groups) {
    const refs = grp.refs;
    const sample = grp.sample;

    if (grp.entryIds.length === 1) {
      // One existing entry — update its refs
      const entry = entryById.get(grp.entryIds[0]);
      if (!entry) continue;
      const currentRefs = new Set(entry.kicad_refs);
      const newRefs = refs.filter((r) => !currentRefs.has(r));
      const removedRefs = entry.kicad_refs.filter((r) => !schRefs.has(r));

      if (newRefs.length > 0 || removedRefs.length > 0) {
        // Add new refs, remove refs not in schematic
        const updatedRefs = new Set([...entry.kicad_refs, ...newRefs]);
        for (const r of removedRefs) updatedRefs.delete(r);
        entry.kicad_refs = [...updatedRefs].sort();
        entry.kicad_footprint = sample.footprint;
        entry.updated = now;

        updated.push({
          id: entry.id,
          role: entry.role,
          refsAdded: newRefs,
          refsRemoved: removedRefs,
        });
      }
    } else if (grp.entryIds.length === 0) {
      // No existing entry — create one
      // Try to find an LCSC part number from JLCPCB plugin
      let lcsc: string | null = null;
      for (const ref of refs) {
        const l = jlcpcbMap.get(ref);
        if (l) { lcsc = l; break; }
      }

      const category = inferCategory(sample.libId, sample.ref);
      let role = buildRole(sample);
      let manufacturer: string | undefined;
      let mpn: string | undefined;
      let description: string | undefined;
      let datasheetUrl: string | undefined;

      // If online and we have an LCSC number, fetch details
      if (opts.online && lcsc) {
        onProgress?.(`Looking up ${lcsc}...`);
        try {
          const hit = await lookupPart(lcsc);
          if (hit) {
            manufacturer = hit.manufacturer || undefined;
            mpn = hit.mpn || undefined;
            description = hit.description || undefined;
            datasheetUrl = hit.datasheet_url ?? undefined;
            // Use LCSC description as role if our inferred one is just the value
            if (hit.description && role === sample.value) {
              role = hit.description;
            }
          }
        } catch {
          // API failure — proceed without details
        }
      }

      // Use schematic datasheet if available and no LCSC one
      if (!datasheetUrl && sample.datasheet && sample.datasheet !== "~") {
        datasheetUrl = sample.datasheet;
      }

      const entry: BomEntry = {
        id: randomUUID(),
        role,
        category,
        description,
        manufacturer,
        mpn,
        sources: lcsc
          ? [{ supplier: "lcsc", part_number: lcsc, last_checked: now }]
          : [],
        datasheet_url: datasheetUrl,
        kicad_refs: refs,
        kicad_footprint: sample.footprint,
        alternates: [],
        status: "candidate",
        added: now,
        updated: now,
      };

      bom.entries.push(entry);
      added.push({ id: entry.id, role, category, refs, lcsc });
    }
    // If grp.entryIds.length > 1, the same component group is split across
    // multiple BOM entries — don't touch, let the user resolve manually.
  }

  // Find orphaned BOM entries — entries whose refs no longer exist in the schematic
  const orphaned: SyncOrphanedEntry[] = [];
  for (const entry of bom.entries) {
    const deadRefs = entry.kicad_refs.filter((r) => !schRefs.has(r));
    if (deadRefs.length > 0 && deadRefs.length === entry.kicad_refs.length) {
      orphaned.push({ id: entry.id, role: entry.role, refs: deadRefs });
    }
  }

  if (!opts.dryRun) {
    await writeBom(root, bom);
  }

  const unchanged =
    bom.entries.length - added.length - updated.length - orphaned.length;

  return {
    ok: true,
    added,
    updated,
    orphaned,
    unchanged: Math.max(0, unchanged),
    schematicComponents: schComponents.length,
  };
}
