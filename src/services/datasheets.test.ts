import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../commands/init/core.js";
import {
  datasheetsDir,
  fetchDatasheet,
  listCachedDatasheets,
  pagesDir,
  resolveCachedDatasheet,
  slugify,
} from "./datasheets.js";
import { buildTestPdf } from "./pdf.test.js";

let testDir: string;
let fixturePdf: Uint8Array<ArrayBuffer>;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "pcbpal-datasheets-test-"));
  await initProject({ dir: testDir });
  fixturePdf = buildTestPdf([
    "Figure 1. Test application circuit",
    "Table 2. Electrical characteristics",
  ]);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("slugify", () => {
  test("lowercases and hyphenates", () => {
    expect(slugify("AMS1117-3.3 Datasheet.pdf")).toBe("ams1117-3-3-datasheet");
  });

  test("strips a trailing extension", () => {
    expect(slugify("some-file.PDF")).toBe("some-file");
  });

  test("falls back to a default for empty input", () => {
    expect(slugify("...")).toBe("datasheet");
  });
});

describe("datasheetsDir / pagesDir", () => {
  test("nests under .pcbpal/datasheets", () => {
    expect(datasheetsDir(testDir)).toBe(join(testDir, ".pcbpal", "datasheets"));
    expect(pagesDir(testDir)).toBe(join(testDir, ".pcbpal", "datasheets", "pages"));
  });
});

describe("fetchDatasheet", () => {
  test("rejects a non-PDF response with a clear error", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("<html>not a pdf</html>", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const url = `http://localhost:${server.port}/datasheet.pdf`;

    await expect(fetchDatasheet(testDir, { url })).rejects.toThrow(/did not return a PDF/i);
  });

  test("downloads a PDF, computes checksum, and writes a sidecar", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(fixturePdf, { headers: { "content-type": "application/pdf" } });
      },
    });
    const url = `http://localhost:${server.port}/ams1117.pdf`;

    const result = await fetchDatasheet(testDir, { url, mpn: "AMS1117-3.3", lcsc: "C6186" });

    expect(result.cached).toBe(false);
    expect(result.url).toBe(url);
    expect(result.mpn).toBe("AMS1117-3.3");
    expect(result.lcsc).toBe("C6186");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.size_bytes).toBe(fixturePdf.byteLength);

    const onDisk = await readFile(result.path);
    expect(onDisk.byteLength).toBe(fixturePdf.byteLength);

    const meta = await readFile(`${result.path}.meta.json`, "utf-8");
    expect(JSON.parse(meta).sha256).toBe(result.sha256);
  });

  test("is idempotent by URL (second fetch short-circuits without re-downloading)", async () => {
    let hits = 0;
    using server = Bun.serve({
      port: 0,
      fetch() {
        hits++;
        return new Response(fixturePdf, { headers: { "content-type": "application/pdf" } });
      },
    });
    const url = `http://localhost:${server.port}/ams1117.pdf`;

    const first = await fetchDatasheet(testDir, { url, mpn: "AMS1117-3.3" });
    const second = await fetchDatasheet(testDir, { url, mpn: "AMS1117-3.3" });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.sha256).toBe(first.sha256);
    expect(hits).toBe(1);
  });

  test("dedupes by checksum even when the URL differs", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(fixturePdf, { headers: { "content-type": "application/pdf" } });
      },
    });
    const urlA = `http://localhost:${server.port}/a.pdf`;
    const urlB = `http://localhost:${server.port}/b.pdf`;

    const first = await fetchDatasheet(testDir, { url: urlA, mpn: "PART-A" });
    const second = await fetchDatasheet(testDir, { url: urlB, mpn: "PART-A" });

    expect(second.cached).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.url).toBe(urlA);
  });
});

describe("listCachedDatasheets / resolveCachedDatasheet", () => {
  async function seed(): Promise<{ url: string; path: string; sha256: string }> {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(fixturePdf, { headers: { "content-type": "application/pdf" } });
      },
    });
    const url = `http://localhost:${server.port}/ams1117.pdf`;
    const result = await fetchDatasheet(testDir, { url, mpn: "AMS1117-3.3", lcsc: "C6186" });
    return { url, path: result.path, sha256: result.sha256 };
  }

  test("listCachedDatasheets returns the seeded record", async () => {
    await seed();
    const all = await listCachedDatasheets(testDir);
    expect(all).toHaveLength(1);
    expect(all[0].mpn).toBe("AMS1117-3.3");
  });

  test("returns [] when the cache directory doesn't exist yet", async () => {
    await rm(datasheetsDir(testDir), { recursive: true, force: true });
    expect(await listCachedDatasheets(testDir)).toEqual([]);
  });

  test("resolves by mpn (case-insensitive)", async () => {
    await seed();
    const found = await resolveCachedDatasheet(testDir, "ams1117-3.3");
    expect(found?.mpn).toBe("AMS1117-3.3");
  });

  test("resolves by lcsc id", async () => {
    await seed();
    const found = await resolveCachedDatasheet(testDir, "C6186");
    expect(found?.lcsc).toBe("C6186");
  });

  test("resolves by sha256 prefix", async () => {
    const { sha256 } = await seed();
    const found = await resolveCachedDatasheet(testDir, sha256.slice(0, 10));
    expect(found?.sha256).toBe(sha256);
  });

  test("resolves by direct file path even when uncached", async () => {
    const looseDir = await mkdtemp(join(tmpdir(), "pcbpal-loose-pdf-"));
    const loosePath = join(looseDir, "loose.pdf");
    await Bun.write(loosePath, fixturePdf);

    const found = await resolveCachedDatasheet(testDir, loosePath);
    expect(found).not.toBeNull();
    expect(found?.path).toBe(loosePath);
    expect(found?.sha256).toMatch(/^[0-9a-f]{64}$/);

    await rm(looseDir, { recursive: true, force: true });
  });

  test("returns null for an unknown reference", async () => {
    expect(await resolveCachedDatasheet(testDir, "no-such-part")).toBeNull();
  });
});
