import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchDatasheet } from "../../services/datasheets.js";
import { detectPdfTools } from "../../services/pdf.js";
import { buildTestPdf } from "../../services/pdf.test.js";
import { initProject } from "../init/core.js";
import { extractPrepare } from "./extract.js";

// `test.skipIf` reads this synchronously while the file is being collected,
// before `beforeEach` runs — so tool detection must happen via top-level
// await, not inside a lifecycle hook.
const availableTools = await detectPdfTools();
const toolsAvailable =
  availableTools.pdftoppm && availableTools.pdftotext && availableTools.pdfinfo;

let testDir: string;
let origCwd: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "pcbpal-extract-test-"));
  await initProject({ dir: testDir });
  origCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(async () => {
  process.chdir(origCwd);
  await rm(testDir, { recursive: true, force: true });
});

/** Cache a synthetic multi-page datasheet directly (no network mpn lookup). */
async function cacheFixture(pageTexts: string[], mpn?: string): Promise<{ sha256: string }> {
  const pdf = buildTestPdf(pageTexts);
  using server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(pdf, { headers: { "content-type": "application/pdf" } });
    },
  });
  const url = `http://localhost:${server.port}/part.pdf`;
  const result = await fetchDatasheet(testDir, { url, mpn });
  return { sha256: result.sha256 };
}

const THREE_FACET_PAGES = [
  "Figure 1. Typical Application Circuit",
  "Table 3. Electrical Characteristics",
  "Table 1. Pin Description",
];

describe("extractPrepare — auto-detection", () => {
  test.skipIf(!toolsAvailable)("picks the circuit page from its caption", async () => {
    const { sha256 } = await cacheFixture(THREE_FACET_PAGES, "MP2315");
    const result = await extractPrepare({ source: sha256.slice(0, 8), facet: "circuit" });

    expect(result.ok).toBe(true);
    expect(result.autoDetectedPages).toBe(true);
    expect(result.manifest.pages).toEqual([1]);
    expect(result.manifest.device).toBe("MP2315");
    expect(result.manifest.facet).toBe("circuit");
    expect(result.manifest.truncated_pages).toBeUndefined();
    expect(result.taskDir).toBe(join(testDir, ".pcbpal", "datasheets", "tasks", "mp2315-circuit"));
  });

  test.skipIf(!toolsAvailable)("picks the specs page from its caption", async () => {
    const { sha256 } = await cacheFixture(THREE_FACET_PAGES, "MP2315");
    const result = await extractPrepare({ source: sha256.slice(0, 8), facet: "specs" });

    expect(result.autoDetectedPages).toBe(true);
    expect(result.manifest.pages).toEqual([2]);
  });

  test.skipIf(!toolsAvailable)("picks the pins page from its caption", async () => {
    const { sha256 } = await cacheFixture(THREE_FACET_PAGES, "MP2315");
    const result = await extractPrepare({ source: sha256.slice(0, 8), facet: "pins" });

    expect(result.autoDetectedPages).toBe(true);
    expect(result.manifest.pages).toEqual([3]);
  });

  test.skipIf(!toolsAvailable)(
    "caps auto-detected pages at 8 and sets truncated_pages",
    async () => {
      // 10 pages that all match the "specs" heuristic.
      const pageTexts = Array.from(
        { length: 10 },
        (_, i) => `Table ${i + 1}. Electrical Characteristics`,
      );
      const { sha256 } = await cacheFixture(pageTexts, "MP2315");
      const result = await extractPrepare({ source: sha256.slice(0, 8), facet: "specs" });

      expect(result.manifest.pages).toHaveLength(8);
      expect(result.manifest.pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(result.manifest.truncated_pages).toBe(true);
    },
  );

  test.skipIf(!toolsAvailable)(
    "throws and lists detected captions when nothing matches",
    async () => {
      const { sha256 } = await cacheFixture(
        ["Figure 5. Block Diagram", "Table 9. Ordering Information"],
        "MP2315",
      );

      await expect(extractPrepare({ source: sha256.slice(0, 8), facet: "pins" })).rejects.toThrow(
        /Could not auto-detect pages for facet "pins"/,
      );
      await expect(extractPrepare({ source: sha256.slice(0, 8), facet: "pins" })).rejects.toThrow(
        /Block Diagram/,
      );
      await expect(extractPrepare({ source: sha256.slice(0, 8), facet: "pins" })).rejects.toThrow(
        /--pages/,
      );
    },
  );
});

describe("extractPrepare — explicit --pages", () => {
  test.skipIf(!toolsAvailable)("overrides auto-detection", async () => {
    const { sha256 } = await cacheFixture(THREE_FACET_PAGES, "MP2315");
    const result = await extractPrepare({
      source: sha256.slice(0, 8),
      facet: "circuit",
      pages: "2",
    });

    expect(result.autoDetectedPages).toBe(false);
    expect(result.manifest.pages).toEqual([2]);
  });

  test.skipIf(!toolsAvailable)("throws for an out-of-range page", async () => {
    const { sha256 } = await cacheFixture(THREE_FACET_PAGES, "MP2315");
    await expect(
      extractPrepare({ source: sha256.slice(0, 8), facet: "circuit", pages: "99" }),
    ).rejects.toThrow(/exceed document length/);
  });
});

describe("extractPrepare — task package contents", () => {
  test.skipIf(!toolsAvailable)(
    "renders images and writes schema.json, instructions.md, manifest.json",
    async () => {
      const { sha256 } = await cacheFixture(THREE_FACET_PAGES, "MP2315");
      const result = await extractPrepare({
        source: sha256.slice(0, 8),
        facet: "specs",
        dpi: 100,
      });

      const files = await readdir(result.taskDir);
      expect(files.sort()).toEqual(["instructions.md", "manifest.json", "pages", "schema.json"]);

      const pageFiles = await readdir(join(result.taskDir, "pages"));
      expect(pageFiles).toEqual(["page-2.png"]);
      expect(result.manifest.images).toEqual(["pages/page-2.png"]);

      const schemaRaw = await readFile(join(result.taskDir, "schema.json"), "utf-8");
      const schema = JSON.parse(schemaRaw) as { properties: { facet: { const: string } } };
      expect(schema.properties.facet.const).toBe("specs");

      const instructions = await readFile(join(result.taskDir, "instructions.md"), "utf-8");
      expect(instructions).toContain("MP2315");
      expect(instructions).toContain(result.manifest.pages.join(", "));
      expect(instructions).toContain(result.manifest.output_file);
      expect(instructions).toContain(result.manifest.validate_command);
      expect(instructions).toContain(sha256);

      const manifestRaw = await readFile(join(result.taskDir, "manifest.json"), "utf-8");
      const manifest = JSON.parse(manifestRaw);
      expect(manifest.output_file).toBe(
        join(testDir, ".pcbpal", "datasheets", "extracted", "mp2315-specs.json"),
      );
      expect(manifest.validate_command).toBe(
        `pcbpal datasheet validate ${manifest.output_file} --json`,
      );
      expect(manifest.pdf_sha256).toBe(sha256);
      expect(manifest.schema_file).toBe("schema.json");
      expect(manifest.instructions_file).toBe("instructions.md");
    },
  );

  test.skipIf(!toolsAvailable)("respects an explicit --device override", async () => {
    const { sha256 } = await cacheFixture(THREE_FACET_PAGES, "MP2315");
    const result = await extractPrepare({
      source: sha256.slice(0, 8),
      facet: "specs",
      device: "MP2315GJ",
    });
    expect(result.manifest.device).toBe("MP2315GJ");
    expect(result.taskDir).toBe(join(testDir, ".pcbpal", "datasheets", "tasks", "mp2315gj-specs"));
  });

  test.skipIf(!toolsAvailable)(
    "re-running is idempotent (clean task dir, no leftovers)",
    async () => {
      const { sha256 } = await cacheFixture(THREE_FACET_PAGES, "MP2315");
      const first = await extractPrepare({ source: sha256.slice(0, 8), facet: "circuit" });
      const firstFiles = await readdir(first.taskDir);

      // Simulate a stray leftover file from a previous run.
      await writeFile(join(first.taskDir, "stray.tmp"), "leftover", "utf-8");

      const second = await extractPrepare({ source: sha256.slice(0, 8), facet: "circuit" });
      const secondFiles = await readdir(second.taskDir);

      expect(second.taskDir).toBe(first.taskDir);
      expect(secondFiles.sort()).toEqual(firstFiles.sort());
      expect(secondFiles).not.toContain("stray.tmp");
    },
  );
});

describe("extractPrepare — errors", () => {
  test("throws when not in a pcbpal project", async () => {
    process.chdir(origCwd);
    const outsideDir = await mkdtemp(join(tmpdir(), "pcbpal-extract-outside-"));
    process.chdir(outsideDir);
    try {
      await expect(extractPrepare({ source: "whatever", facet: "specs" })).rejects.toThrow(
        /Not in a pcbpal project/,
      );
    } finally {
      process.chdir(testDir);
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test("throws when the source can't be resolved", async () => {
    await expect(extractPrepare({ source: "no-such-part", facet: "specs" })).rejects.toThrow(
      /Datasheet not found/,
    );
  });
});
