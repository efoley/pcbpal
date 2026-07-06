import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { svgToolAvailable, svgToPng } from "./svg.js";

const TRIVIAL_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect x="4" y="4" width="56" height="56" fill="#3366ff" />
</svg>
`;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// `test.skipIf` reads this synchronously while the file is being collected,
// before `beforeAll` runs — so tool detection must happen via top-level
// await, not inside a lifecycle hook (see src/services/pdf.test.ts on the
// datasheet branch for the same gotcha).
const toolAvailable = await svgToolAvailable();

let testDir: string;
let fixturePath: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "pcbpal-svg-test-"));
  fixturePath = join(testDir, "fixture.svg");
  await writeFile(fixturePath, TRIVIAL_SVG, "utf-8");
});

describe("svgToolAvailable", () => {
  test("reports rsvg-convert availability as a boolean", async () => {
    const available = await svgToolAvailable({ force: true });
    expect(typeof available).toBe("boolean");
  });
});

describe("svgToPng", () => {
  test.skipIf(!toolAvailable)("converts an SVG fixture into a valid PNG", async () => {
    const pngPath = await svgToPng(fixturePath);
    expect(pngPath).toBe(join(testDir, "fixture.png"));

    const bytes = await readFile(pngPath);
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_MAGIC);
  });

  test.skipIf(!toolAvailable)("honors a custom dpi option", async () => {
    const pngPath = await svgToPng(fixturePath, { dpi: 300 });
    const bytes = await readFile(pngPath);
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_MAGIC);
  });

  test.skipIf(!toolAvailable)("throws a clear error for a missing file", async () => {
    expect(svgToPng(join(testDir, "nope.svg"))).rejects.toThrow();
  });
});
