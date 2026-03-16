import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchComponentDetail } from "../../services/lcsc.js";
import { findProjectRoot } from "../../services/project.js";

export interface LibFetchOptions {
  lcsc: string;
}

export interface LibFetchResult {
  ok: true;
  lcsc: string;
  mpn: string;
  description: string;
  symbolPath: string | null;
  footprintPath: string | null;
}

export async function libFetch(opts: LibFetchOptions): Promise<LibFetchResult> {
  const root = await findProjectRoot();
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }

  // Fetch component detail from LCSC
  const detail = await fetchComponentDetail(opts.lcsc);

  let symbolPath: string | null = null;
  let footprintPath: string | null = null;

  // Save symbol data if available
  if (detail.symbol) {
    const symDir = join(root, ".pcbpal", "symbols");
    await mkdir(symDir, { recursive: true });
    symbolPath = join(symDir, `${opts.lcsc}.json`);
    await writeFile(symbolPath, JSON.stringify(detail.symbol, null, 2), "utf-8");
  }

  // Save footprint data if available
  if (detail.footprint) {
    const fpDir = join(root, ".pcbpal", "footprints");
    await mkdir(fpDir, { recursive: true });
    footprintPath = join(fpDir, `${opts.lcsc}.json`);
    await writeFile(footprintPath, JSON.stringify(detail.footprint, null, 2), "utf-8");
  }

  return {
    ok: true,
    lcsc: opts.lcsc,
    mpn: detail.mpn,
    description: detail.description,
    symbolPath,
    footprintPath,
  };
}
