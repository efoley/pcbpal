import { randomUUID } from "node:crypto";
import type { BomCategory, BomDatabase, BomEntry, BomStatus } from "../../schemas/bom.js";
import { lookupPart } from "../../services/lcsc.js";
import { findProjectRoot, readBom, writeBom } from "../../services/project.js";

export interface BomAddOptions {
  role: string;
  category: BomCategory;
  manufacturer?: string;
  mpn?: string;
  lcsc?: string;
  description?: string;
  notes?: string;
  selectionNotes?: string;
  datasheetUrl?: string;
  refs?: string[];
  status?: BomStatus;
}

export interface BomAddResult {
  ok: true;
  entry: BomEntry;
}

export interface BomShowOptions {
  status?: BomStatus;
  category?: BomCategory;
  subcircuit?: string;
  groupBy?: "category" | "subcircuit" | "status";
}

export interface BomShowResult {
  schema_version: 1;
  entries: BomEntry[];
  total: number;
}

export interface BomRemoveResult {
  ok: true;
  removed: BomEntry;
}

export interface BomLinkResult {
  ok: true;
  entry: BomEntry;
}

async function loadBom(): Promise<{ root: string; bom: BomDatabase }> {
  const root = await findProjectRoot();
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }
  const bom = await readBom(root);
  return { root, bom };
}

export async function bomAdd(opts: BomAddOptions): Promise<BomAddResult> {
  const { root, bom } = await loadBom();
  const now = new Date().toISOString();

  // Auto-populate from LCSC if a part number is provided
  let manufacturer = opts.manufacturer;
  let mpn = opts.mpn;
  let description = opts.description;
  let datasheetUrl = opts.datasheetUrl;
  let stock: number | undefined;
  let unitPrice: number | undefined;

  if (opts.lcsc) {
    const hit = await lookupPart(opts.lcsc);
    if (hit) {
      manufacturer ??= hit.manufacturer || undefined;
      mpn ??= hit.mpn || undefined;
      description ??= hit.description || undefined;
      datasheetUrl ??= hit.datasheet_url ?? undefined;
      stock = hit.stock;
      unitPrice = hit.unit_price_usd ?? undefined;
    }
  }

  const entry: BomEntry = {
    id: randomUUID(),
    role: opts.role,
    category: opts.category,
    description,
    manufacturer,
    mpn,
    sources: opts.lcsc
      ? [
          {
            supplier: "lcsc",
            part_number: opts.lcsc,
            ...(stock !== undefined ? { stock } : {}),
            ...(unitPrice !== undefined ? { unit_price_usd: unitPrice } : {}),
            last_checked: now,
          },
        ]
      : [],
    selection_notes: opts.selectionNotes,
    datasheet_url: datasheetUrl,
    notes: opts.notes,
    kicad_refs: opts.refs ?? [],
    alternates: [],
    status: opts.status ?? "candidate",
    added: now,
    updated: now,
  };

  bom.entries.push(entry);
  await writeBom(root, bom);

  return { ok: true, entry };
}

export async function bomShow(opts: BomShowOptions): Promise<BomShowResult> {
  const { bom } = await loadBom();

  let entries = bom.entries;

  if (opts.status) {
    entries = entries.filter((e) => e.status === opts.status);
  }
  if (opts.category) {
    entries = entries.filter((e) => e.category === opts.category);
  }
  if (opts.subcircuit) {
    entries = entries.filter((e) => e.subcircuit === opts.subcircuit);
  }

  return {
    schema_version: 1,
    entries,
    total: entries.length,
  };
}

export async function bomRemove(id: string): Promise<BomRemoveResult> {
  const { root, bom } = await loadBom();

  const idx = bom.entries.findIndex((e) => e.id === id || e.id.startsWith(id));
  if (idx === -1) {
    throw new Error(`BOM entry not found: ${id}`);
  }

  const [removed] = bom.entries.splice(idx, 1);
  await writeBom(root, bom);

  return { ok: true, removed };
}

export async function bomLink(id: string, refs: string[]): Promise<BomLinkResult> {
  const { root, bom } = await loadBom();

  const entry = bom.entries.find((e) => e.id === id || e.id.startsWith(id));
  if (!entry) {
    throw new Error(`BOM entry not found: ${id}`);
  }

  // Merge refs, deduplicating
  const allRefs = new Set([...entry.kicad_refs, ...refs]);
  entry.kicad_refs = [...allRefs];
  entry.updated = new Date().toISOString();

  await writeBom(root, bom);

  return { ok: true, entry };
}
