import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPdfTools, pdfInfo, pdfText, renderPdfPages } from "./pdf.js";

/**
 * Build a minimal, valid, uncompressed PDF 1.4 file with one page per
 * entry in `pageTexts`, each page rendering its text via a trivial
 * `Tj` content stream. Byte offsets for the xref table are computed
 * exactly (not guessed), so poppler parses it without falling back to
 * its lenient recovery mode.
 */
export function buildTestPdf(pageTexts: string[]): Uint8Array<ArrayBuffer> {
  const numPages = pageTexts.length;
  const catalogNum = 1;
  const pagesNum = 2;
  const firstPageNum = 3;
  const pageNums = Array.from({ length: numPages }, (_, i) => firstPageNum + i);
  const contentNums = Array.from({ length: numPages }, (_, i) => firstPageNum + numPages + i);
  const fontNum = firstPageNum + numPages * 2;
  const totalObjs = fontNum;

  const kids = pageNums.map((n) => `${n} 0 R`).join(" ");

  const bodies: string[] = new Array(totalObjs + 1).fill("");
  bodies[catalogNum] = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
  bodies[pagesNum] = `<< /Type /Pages /Kids [${kids}] /Count ${numPages} >>`;

  for (let i = 0; i < numPages; i++) {
    bodies[pageNums[i]] =
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`;
  }

  for (let i = 0; i < numPages; i++) {
    const escaped = pageTexts[i].replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    bodies[contentNums[i]] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  bodies[fontNum] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let out = "%PDF-1.4\n";
  const offsets: number[] = new Array(totalObjs + 1).fill(0);
  for (let n = 1; n <= totalObjs; n++) {
    offsets[n] = Buffer.byteLength(out, "utf-8");
    out += `${n} 0 obj\n${bodies[n]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(out, "utf-8");
  out += `xref\n0 ${totalObjs + 1}\n`;
  out += "0000000000 65535 f \r\n";
  for (let n = 1; n <= totalObjs; n++) {
    out += `${String(offsets[n]).padStart(10, "0")} 00000 n \r\n`;
  }
  out += `trailer\n<< /Size ${totalObjs + 1} /Root ${catalogNum} 0 R >>\n`;
  out += `startxref\n${xrefOffset}\n%%EOF`;

  return new TextEncoder().encode(out);
}

// `test.skipIf` reads this synchronously while the file is being collected,
// before `beforeAll` runs — so tool detection must happen via top-level
// await, not inside a lifecycle hook.
const availableTools = await detectPdfTools();
const toolsAvailable =
  availableTools.pdftoppm && availableTools.pdftotext && availableTools.pdfinfo;

let testDir: string;
let fixturePath: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "pcbpal-pdf-test-"));
  fixturePath = join(testDir, "fixture.pdf");
  const pdf = buildTestPdf([
    "Figure 1. Test application circuit",
    "Table 2. Electrical characteristics",
  ]);
  await writeFile(fixturePath, pdf);
});

describe("detectPdfTools", () => {
  test("reports poppler-utils availability", async () => {
    const tools = await detectPdfTools({ force: true });
    expect(typeof tools.pdftoppm).toBe("boolean");
    expect(typeof tools.pdftotext).toBe("boolean");
    expect(typeof tools.pdfinfo).toBe("boolean");
  });
});

describe("pdfInfo", () => {
  test.skipIf(!toolsAvailable)("reports page count for the fixture PDF", async () => {
    const info = await pdfInfo(fixturePath);
    expect(info.pages).toBe(2);
  });

  test.skipIf(!toolsAvailable)("throws a clear error for a missing file", async () => {
    expect(pdfInfo(join(testDir, "nope.pdf"))).rejects.toThrow();
  });
});

describe("pdfText", () => {
  test.skipIf(!toolsAvailable)("finds Figure 1 caption on page 1", async () => {
    const text = await pdfText(fixturePath, { first: 1, last: 1 });
    expect(text).toContain("Figure 1");
  });

  test.skipIf(!toolsAvailable)("finds Table 2 caption on page 2", async () => {
    const text = await pdfText(fixturePath, { first: 2, last: 2 });
    expect(text).toContain("Table 2");
  });

  test.skipIf(!toolsAvailable)(
    "returns text for the full document when no range given",
    async () => {
      const text = await pdfText(fixturePath);
      expect(text).toContain("Figure 1");
      expect(text).toContain("Table 2");
    },
  );
});

describe("renderPdfPages", () => {
  test.skipIf(!toolsAvailable)("renders both pages as stably-named PNGs", async () => {
    const outDir = join(testDir, "render-out");
    const images = await renderPdfPages(fixturePath, {
      pages: [1, 2],
      dpi: 100,
      outDir,
      prefix: "page",
    });

    expect(images).toHaveLength(2);
    expect(images).toContain(join(outDir, "page-1.png"));
    expect(images).toContain(join(outDir, "page-2.png"));

    const files = await readdir(outDir);
    // No leftover temp files from the rename dance.
    expect(files.sort()).toEqual(["page-1.png", "page-2.png"]);
  });

  test.skipIf(!toolsAvailable)("creates outDir if missing", async () => {
    const outDir = join(testDir, "nested", "render-out2");
    const images = await renderPdfPages(fixturePath, {
      pages: [1],
      dpi: 100,
      outDir,
    });
    expect(images).toEqual([join(outDir, "page-1.png")]);
  });
});
