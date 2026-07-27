/**
 * Core logic for `pcbpal datasheet fetch`. No I/O formatting, no CLI
 * registration — see design-docs/datasheet_understanding_evals.md §5.
 */

import { fetchDatasheet } from "../../services/datasheets.js";
import { fetchComponentDetail } from "../../services/lcsc.js";
import { findProjectRoot, readBom } from "../../services/project.js";

export interface FetchOptions {
  url?: string;
  lcsc?: string;
  bomId?: string;
}

export interface FetchResult {
  ok: true;
  path: string;
  sha256: string;
  url: string;
  cached: boolean;
  mpn?: string;
}

/**
 * Resolve a datasheet URL from --url (highest precedence), then --lcsc
 * (looked up live via the EasyEDA API), then --bom-id (an existing BOM
 * entry's recorded datasheet_url), and download it into the project cache.
 */
export async function fetchDatasheetCommand(opts: FetchOptions): Promise<FetchResult> {
  const root = await findProjectRoot();
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }

  let url = opts.url;
  let mpn: string | undefined;
  let lcsc: string | undefined = opts.lcsc;

  if (!url && opts.lcsc) {
    const detail = await fetchComponentDetail(opts.lcsc);
    if (!detail.datasheet_url) {
      throw new Error(`LCSC part ${opts.lcsc} has no datasheet URL on record`);
    }
    url = detail.datasheet_url;
    mpn = detail.mpn || undefined;
    lcsc = detail.lcsc;
  }

  if (!url && opts.bomId) {
    const bom = await readBom(root);
    const entry = bom.entries.find(
      (e) =>
        e.id === opts.bomId ||
        e.id.startsWith(opts.bomId as string) ||
        e.kicad_refs.includes(opts.bomId as string) ||
        e.mpn === opts.bomId,
    );
    if (!entry) {
      throw new Error(`BOM entry not found: ${opts.bomId}`);
    }
    if (!entry.datasheet_url) {
      throw new Error(
        `BOM entry "${entry.role}" (${entry.id.slice(0, 8)}) has no datasheet_url recorded`,
      );
    }
    url = entry.datasheet_url;
    mpn = entry.mpn ?? mpn;
    lcsc = entry.sources.find((s) => s.supplier === "lcsc")?.part_number ?? lcsc;
  }

  if (!url) {
    throw new Error("Provide --url, --lcsc, or --bom-id to resolve a datasheet");
  }

  const result = await fetchDatasheet(root, { url, mpn, lcsc });

  return {
    ok: true,
    path: result.path,
    sha256: result.sha256,
    url: result.url,
    cached: result.cached,
    ...(result.mpn ? { mpn: result.mpn } : {}),
  };
}
