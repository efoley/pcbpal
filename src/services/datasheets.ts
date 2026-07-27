/**
 * Datasheet PDF cache: download, checksum, dedupe, and lookup by
 * mpn/lcsc id/sha256 prefix/file path.
 *
 * Cache layout under `.pcbpal/datasheets/`:
 *   <sha8>-<slug>.pdf
 *   <sha8>-<slug>.pdf.meta.json   (sidecar CachedDatasheet record)
 */

import { createHash } from "node:crypto";
import { exists, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export function datasheetsDir(root: string): string {
  return join(root, ".pcbpal", "datasheets");
}

export function pagesDir(root: string): string {
  return join(datasheetsDir(root), "pages");
}

/** Lowercase, hyphenated, ASCII-only slug for building cache file names. */
export function slugify(input: string): string {
  const cleaned = input
    .replace(/\.[a-zA-Z0-9]+$/, "") // strip a trailing file extension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "datasheet";
}

export interface CachedDatasheet {
  path: string;
  sha256: string;
  url: string;
  mpn?: string;
  lcsc?: string;
  fetched_at: string;
  size_bytes: number;
}

function metaPathFor(pdfPath: string): string {
  return `${pdfPath}.meta.json`;
}

/**
 * Download a datasheet PDF into the project cache. Idempotent: a prior
 * fetch of the same URL, or a download that happens to match a checksum
 * already in the cache, short-circuits with `cached: true`.
 */
export async function fetchDatasheet(
  root: string,
  opts: { url: string; mpn?: string; lcsc?: string },
): Promise<CachedDatasheet & { cached: boolean }> {
  const dir = datasheetsDir(root);
  await mkdir(dir, { recursive: true });

  const existing = await listCachedDatasheets(root);

  // Short-circuit by URL before downloading anything.
  const byUrl = existing.find((d) => d.url === opts.url);
  if (byUrl) {
    return { ...byUrl, cached: true };
  }

  const res = await fetch(opts.url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download datasheet from ${opts.url}: HTTP ${res.status}`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  const magic = Buffer.from(buf.slice(0, 4)).toString("latin1");
  if (magic !== "%PDF") {
    const contentType = res.headers.get("content-type") ?? "unknown";
    throw new Error(
      `URL did not return a PDF file (content-type: ${contentType}) — datasheet links sometimes ` +
        `redirect to an HTML landing page instead of the raw PDF: ${opts.url}`,
    );
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");

  // Dedupe by checksum even when the URL differs (mirrors, CDN variants).
  const byChecksum = existing.find((d) => d.sha256 === sha256);
  if (byChecksum) {
    return { ...byChecksum, cached: true };
  }

  const slugSource = opts.mpn ?? safeUrlBasename(opts.url);
  const fileName = `${sha256.slice(0, 8)}-${slugify(slugSource)}.pdf`;
  const filePath = join(dir, fileName);

  await writeFile(filePath, buf);

  const record: CachedDatasheet = {
    path: filePath,
    sha256,
    url: opts.url,
    ...(opts.mpn ? { mpn: opts.mpn } : {}),
    ...(opts.lcsc ? { lcsc: opts.lcsc } : {}),
    fetched_at: new Date().toISOString(),
    size_bytes: buf.byteLength,
  };
  await writeFile(metaPathFor(filePath), `${JSON.stringify(record, null, 2)}\n`, "utf-8");

  return { ...record, cached: false };
}

function safeUrlBasename(url: string): string {
  try {
    return basename(new URL(url).pathname) || "datasheet";
  } catch {
    return basename(url) || "datasheet";
  }
}

/** Read all `.meta.json` sidecars in the datasheet cache directory. */
export async function listCachedDatasheets(root: string): Promise<CachedDatasheet[]> {
  const dir = datasheetsDir(root);
  if (!(await exists(dir))) return [];

  const entries = await readdir(dir);
  const metaFiles = entries.filter((f) => f.endsWith(".meta.json"));

  const records: CachedDatasheet[] = [];
  for (const f of metaFiles) {
    try {
      const raw = await readFile(join(dir, f), "utf-8");
      records.push(JSON.parse(raw) as CachedDatasheet);
    } catch {
      // Skip corrupt/partial sidecar files rather than failing the whole list.
    }
  }
  return records;
}

/**
 * Resolve a datasheet reference. `ref` may be:
 *   - an existing file path (used directly, hashed on the fly)
 *   - an mpn (case-insensitive exact match)
 *   - an lcsc id (case-insensitive exact match)
 *   - a sha256 prefix
 * Returns null if nothing matches.
 */
export async function resolveCachedDatasheet(
  root: string,
  ref: string,
): Promise<CachedDatasheet | null> {
  const records = await listCachedDatasheets(root);
  const lowerRef = ref.toLowerCase();

  const byMpn = records.find((d) => d.mpn?.toLowerCase() === lowerRef);
  if (byMpn) return byMpn;

  const byLcsc = records.find((d) => d.lcsc?.toLowerCase() === lowerRef);
  if (byLcsc) return byLcsc;

  const byChecksum = records.find((d) => d.sha256.startsWith(lowerRef));
  if (byChecksum) return byChecksum;

  // Fall back to treating the ref as a direct file path.
  if (await exists(ref)) {
    const existingRecord = records.find((d) => d.path === ref);
    if (existingRecord) return existingRecord;

    const stats = await stat(ref);
    const buf = await readFile(ref);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    return {
      path: ref,
      sha256,
      url: "",
      fetched_at: new Date().toISOString(),
      size_bytes: stats.size,
    };
  }

  return null;
}
