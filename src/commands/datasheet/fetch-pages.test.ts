import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPdfTools } from "../../services/pdf.js";
import { buildTestPdf } from "../../services/pdf.test.js";
import { bomAdd } from "../bom/core.js";
import { initProject } from "../init/core.js";
import { fetchDatasheetCommand } from "./fetch.js";
import {
  type PagesListResult,
  type PagesRenderResult,
  pagesCommand,
  parsePageSpec,
} from "./pages.js";

// `test.skipIf` reads this synchronously while the file is being collected,
// before `beforeEach` runs — so tool detection must happen via top-level
// await, not inside a lifecycle hook.
const availableTools = await detectPdfTools();
const toolsAvailable =
  availableTools.pdftoppm && availableTools.pdftotext && availableTools.pdfinfo;

let testDir: string;
let origCwd: string;
let fixturePdf: Uint8Array<ArrayBuffer>;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "pcbpal-datasheet-cmd-test-"));
  await initProject({ dir: testDir });
  origCwd = process.cwd();
  process.chdir(testDir);

  fixturePdf = buildTestPdf([
    "Figure 1. Test application circuit",
    "Table 2. Electrical characteristics",
  ]);
});

afterEach(async () => {
  process.chdir(origCwd);
  await rm(testDir, { recursive: true, force: true });
});

describe("parsePageSpec", () => {
  test("parses a comma-separated list with a range", () => {
    expect(parsePageSpec("3,7-9")).toEqual([3, 7, 8, 9]);
  });

  test("de-duplicates and sorts", () => {
    expect(parsePageSpec("9,1,1,3-5")).toEqual([1, 3, 4, 5, 9]);
  });

  test("expands 'all' given a total page count", () => {
    expect(parsePageSpec("all", 4)).toEqual([1, 2, 3, 4]);
  });

  test("throws for 'all' without a total page count", () => {
    expect(() => parsePageSpec("all")).toThrow(/total page count/);
  });

  test("throws on a nonsense spec", () => {
    expect(() => parsePageSpec("banana")).toThrow(/Invalid page spec/);
  });

  test("throws on an inverted range", () => {
    expect(() => parsePageSpec("9-3")).toThrow(/Invalid page range/);
  });

  test("throws on page zero", () => {
    expect(() => parsePageSpec("0")).toThrow();
  });
});

describe("fetchDatasheetCommand", () => {
  test("throws when not in a pcbpal project", async () => {
    process.chdir(origCwd);
    const outsideDir = await mkdtemp(join(tmpdir(), "pcbpal-outside-"));
    process.chdir(outsideDir);
    try {
      await expect(
        fetchDatasheetCommand({ url: "http://localhost:1/whatever.pdf" }),
      ).rejects.toThrow(/Not in a pcbpal project/);
    } finally {
      process.chdir(testDir);
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("throws when no url/lcsc/bom-id is provided", async () => {
    await expect(fetchDatasheetCommand({})).rejects.toThrow(/Provide --url, --lcsc, or --bom-id/);
  });

  test("downloads via --url", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(fixturePdf, { headers: { "content-type": "application/pdf" } });
      },
    });
    const url = `http://localhost:${server.port}/part.pdf`;

    const result = await fetchDatasheetCommand({ url });

    expect(result.ok).toBe(true);
    expect(result.url).toBe(url);
    expect(result.cached).toBe(false);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("resolves via --bom-id using the BOM entry's datasheet_url", async () => {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(fixturePdf, { headers: { "content-type": "application/pdf" } });
      },
    });
    const url = `http://localhost:${server.port}/part.pdf`;

    const { entry } = await bomAdd({
      role: "LDO",
      category: "ic",
      mpn: "AMS1117-3.3",
      datasheetUrl: url,
    });

    const result = await fetchDatasheetCommand({ bomId: entry.id.slice(0, 8) });
    expect(result.ok).toBe(true);
    expect(result.url).toBe(url);
    expect(result.mpn).toBe("AMS1117-3.3");
  });

  test("throws a clear error when the BOM entry has no datasheet_url", async () => {
    const { entry } = await bomAdd({ role: "Mystery part", category: "other" });
    await expect(fetchDatasheetCommand({ bomId: entry.id })).rejects.toThrow(
      /has no datasheet_url/,
    );
  });

  test("throws when the bom-id doesn't match any entry", async () => {
    await expect(fetchDatasheetCommand({ bomId: "nonexistent" })).rejects.toThrow(
      /BOM entry not found/,
    );
  });
});

describe("pagesCommand", () => {
  async function fetchFixture(): Promise<{ sha256: string; mpn: string }> {
    using server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(fixturePdf, { headers: { "content-type": "application/pdf" } });
      },
    });
    const url = `http://localhost:${server.port}/part.pdf`;
    const result = await fetchDatasheetCommand({ url });
    return { sha256: result.sha256, mpn: result.mpn ?? "" };
  }

  test("throws when the source can't be resolved", async () => {
    await expect(pagesCommand({ source: "no-such-part", list: true })).rejects.toThrow(
      /Datasheet not found/,
    );
  });

  test.skipIf(!toolsAvailable)(
    "--list builds a page index with figure/table captions",
    async () => {
      const { sha256 } = await fetchFixture();
      const result = (await pagesCommand({
        source: sha256.slice(0, 8),
        list: true,
      })) as PagesListResult;

      expect(result.ok).toBe(true);
      expect(result.pages).toBe(2);
      expect(result.index).toHaveLength(2);

      const page1 = result.index.find((p) => p.page === 1);
      const page2 = result.index.find((p) => p.page === 2);
      expect(page1?.figures.some((f) => f.includes("Figure 1"))).toBe(true);
      expect(page1?.tables).toEqual([]);
      expect(page2?.tables.some((t) => t.includes("Table 2"))).toBe(true);
      expect(page2?.figures).toEqual([]);
    },
  );

  test.skipIf(!toolsAvailable)(
    "renders requested pages to PNGs under the pages cache dir",
    async () => {
      const { sha256 } = await fetchFixture();
      const result = (await pagesCommand({
        source: sha256.slice(0, 8),
        pages: "1-2",
        dpi: 100,
      })) as PagesRenderResult;

      expect(result.ok).toBe(true);
      expect(result.images).toHaveLength(2);
      expect(result.outDir).toBe(
        join(testDir, ".pcbpal", "datasheets", "pages", sha256.slice(0, 8)),
      );

      const files = await readdir(result.outDir);
      expect(files.sort()).toEqual(["page-1.png", "page-2.png"]);
    },
  );

  test.skipIf(!toolsAvailable)("defaults to rendering all pages at 200 dpi", async () => {
    const { sha256 } = await fetchFixture();
    const result = (await pagesCommand({ source: sha256.slice(0, 8) })) as PagesRenderResult;
    expect(result.images).toHaveLength(2);
  });

  test.skipIf(!toolsAvailable)(
    "throws when a requested page exceeds the document length",
    async () => {
      const { sha256 } = await fetchFixture();
      await expect(
        pagesCommand({ source: sha256.slice(0, 8), pages: "99", list: true }),
      ).rejects.toThrow(/exceed document length/);
    },
  );

  test.skipIf(!toolsAvailable)("resolves a direct file path source", async () => {
    const { sha256 } = await fetchFixture();
    const cachedPath = join(
      testDir,
      ".pcbpal",
      "datasheets",
      (await readdir(join(testDir, ".pcbpal", "datasheets"))).find(
        (f) => f.startsWith(sha256.slice(0, 8)) && f.endsWith(".pdf"),
      ) as string,
    );
    const result = (await pagesCommand({ source: cachedPath, list: true })) as PagesListResult;
    expect(result.pages).toBe(2);
  });
});
