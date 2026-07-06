/**
 * Record/replay transport for the LCSC search suite.
 *
 * Replay (default) scores from committed recordings under recordings/ and skips
 * with a reason when a query has no recording — so the whole suite runs offline
 * with no network. Live mode (`--live`) hits the real LCSC/JLCPCB search through
 * the shipped `searchComponents` client and RECORDS the top hits (whitelisted
 * fields only) so the recording stays small and committable.
 *
 * NOTE: network to LCSC is blocked in CI (403); live mode is implemented but the
 * offline path is what the tests and default runs exercise. Synthetic recordings
 * (`synthetic: true`) are hand-authored so scoring is fully testable offline.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { searchComponents } from "../../src/services/lcsc.js";

export const RecordedHit = z.object({
  lcsc: z.string(),
  mpn: z.string(),
  manufacturer: z.string(),
  description: z.string(),
  package: z.string(),
  stock: z.number(),
  unit_price_usd: z.number().nullable(),
  library_type: z.enum(["basic", "extended"]),
  has_footprint: z.boolean(),
  has_symbol: z.boolean(),
});
export type RecordedHit = z.infer<typeof RecordedHit>;

export const Recording = z.object({
  synthetic: z.boolean().default(false),
  query: z.string(),
  recorded_at: z.string(),
  hits: z.array(RecordedHit),
});
export type Recording = z.infer<typeof Recording>;

export type FetchResult = { hits: RecordedHit[]; synthetic: boolean } | { skip: string };

export interface SearchTransport {
  fetch(slug: string, query: string): Promise<FetchResult>;
}

function recordingPath(dir: string, slug: string): string {
  return join(dir, `${slug}.json`);
}

/** Scores from committed recordings; skips a query that has none. */
export class ReplayTransport implements SearchTransport {
  constructor(private readonly dir: string) {}

  async fetch(slug: string, _query: string): Promise<FetchResult> {
    const path = recordingPath(this.dir, slug);
    if (!existsSync(path)) {
      return { skip: `no recording (${slug}.json); run --live to record` };
    }
    const rec = Recording.parse(JSON.parse(await readFile(path, "utf-8")));
    return { hits: rec.hits, synthetic: rec.synthetic };
  }
}

/** Hits the live LCSC search and records the top `limit` whitelisted hits. */
export class LiveRecordingTransport implements SearchTransport {
  constructor(
    private readonly dir: string,
    private readonly limit = 20,
  ) {}

  async fetch(slug: string, query: string): Promise<FetchResult> {
    const res = await searchComponents({ query, limit: this.limit });
    const hits: RecordedHit[] = res.results.slice(0, this.limit).map((h) => ({
      lcsc: h.lcsc,
      mpn: h.mpn,
      manufacturer: h.manufacturer,
      description: h.description,
      package: h.package,
      stock: h.stock,
      unit_price_usd: h.unit_price_usd,
      library_type: h.library_type,
      has_footprint: h.has_footprint,
      has_symbol: h.has_symbol,
    }));
    const rec: Recording = {
      synthetic: false,
      query,
      recorded_at: new Date().toISOString(),
      hits,
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(recordingPath(this.dir, slug), `${JSON.stringify(rec, null, 2)}\n`);
    return { hits, synthetic: false };
  }
}
