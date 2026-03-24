import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { exists, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../init/core.js";
import { subBuild, subExport, subList, subNew, subPreview } from "./core.js";

let testDir: string;
let origCwd: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "pcbpal-sub-test-"));
  await initProject({ dir: testDir });
  origCwd = process.cwd();
  process.chdir(testDir);
});

afterEach(async () => {
  process.chdir(origCwd);
  await rm(testDir, { recursive: true, force: true });
});

const SIMPLE_SUBCIRCUIT = `
export const TestCircuit = () => (
  <board width="10mm" height="10mm">
    <resistor name="R1" resistance="10k" footprint="0402" />
  </board>
)
export default TestCircuit
`;

describe("subNew", () => {
  test("scaffolds a new subcircuit file", async () => {
    const result = await subNew({ name: "test-circuit", dir: testDir });

    expect(result.ok).toBe(true);
    expect(result.name).toBe("test-circuit");
    expect(await exists(join(testDir, "subcircuits", "test-circuit.tsx"))).toBe(true);

    const content = await readFile(join(testDir, "subcircuits", "test-circuit.tsx"), "utf-8");
    expect(content).toContain("TestCircuit");
    expect(content).toContain("@pcbpal subcircuit");
  });

  test("rejects duplicate names", async () => {
    await subNew({ name: "dup", dir: testDir });
    expect(subNew({ name: "dup", dir: testDir })).rejects.toThrow("already exists");
  });
});

describe("subList", () => {
  test("returns empty for fresh project", async () => {
    const result = await subList(testDir);
    expect(result.total).toBe(0);
    expect(result.subcircuits).toEqual([]);
  });

  test("lists created subcircuits", async () => {
    await subNew({ name: "alpha", dir: testDir });
    await subNew({ name: "beta", dir: testDir });

    const result = await subList(testDir);
    expect(result.total).toBe(2);
    expect(result.subcircuits.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });
});

describe("subBuild", () => {
  test("compiles a TSX subcircuit to Circuit JSON", async () => {
    await subNew({ name: "simple", dir: testDir });
    await writeFile(join(testDir, "subcircuits", "simple.tsx"), SIMPLE_SUBCIRCUIT, "utf-8");

    const result = await subBuild({ name: "simple", dir: testDir });

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].componentCount).toBeGreaterThanOrEqual(1);

    // Circuit JSON should be saved
    const circuitJsonPath = join(testDir, ".pcbpal", "builds", "simple.circuit.json");
    expect(await exists(circuitJsonPath)).toBe(true);
  });

  test("reports errors for missing file", async () => {
    const result = await subBuild({ name: "nonexistent", dir: testDir });

    expect(result.ok).toBe(false);
    expect(result.results[0].errors).toHaveLength(1);
    expect(result.results[0].errors[0].type).toBe("not_found");
  });

  test("builds all subcircuits with --all", async () => {
    await subNew({ name: "a", dir: testDir });
    await subNew({ name: "b", dir: testDir });
    await writeFile(join(testDir, "subcircuits", "a.tsx"), SIMPLE_SUBCIRCUIT, "utf-8");
    await writeFile(join(testDir, "subcircuits", "b.tsx"), SIMPLE_SUBCIRCUIT, "utf-8");

    const result = await subBuild({ all: true, dir: testDir });

    expect(result.total).toBe(2);
    expect(result.results.every((r) => r.ok)).toBe(true);
  });
});

describe("subPreview", () => {
  test("generates a schematic SVG", async () => {
    await subNew({ name: "prev", dir: testDir });
    await writeFile(join(testDir, "subcircuits", "prev.tsx"), SIMPLE_SUBCIRCUIT, "utf-8");
    await subBuild({ name: "prev", dir: testDir });

    const result = await subPreview({ name: "prev", dir: testDir });

    expect(result.ok).toBe(true);
    expect(result.view).toBe("schematic");
    expect(await exists(result.path)).toBe(true);

    const svg = await readFile(result.path, "utf-8");
    expect(svg).toContain("<svg");
  });

  test("generates a PCB SVG", async () => {
    await subNew({ name: "pcb", dir: testDir });
    await writeFile(join(testDir, "subcircuits", "pcb.tsx"), SIMPLE_SUBCIRCUIT, "utf-8");
    await subBuild({ name: "pcb", dir: testDir });

    const result = await subPreview({ name: "pcb", view: "pcb", dir: testDir });

    expect(result.ok).toBe(true);
    expect(result.view).toBe("pcb");
    const svg = await readFile(result.path, "utf-8");
    expect(svg).toContain("<svg");
  });
});

describe("subExport", () => {
  test("exports to KiCad schematic", async () => {
    await subNew({ name: "exp", dir: testDir });
    await writeFile(join(testDir, "subcircuits", "exp.tsx"), SIMPLE_SUBCIRCUIT, "utf-8");
    await subBuild({ name: "exp", dir: testDir });

    const result = await subExport({ name: "exp", dir: testDir });

    expect(result.ok).toBe(true);
    expect(result.format).toBe("kicad_sch");
    expect(await exists(result.path)).toBe(true);

    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("kicad_sch");
  });

  test("exports to KiCad PCB", async () => {
    await subNew({ name: "exp-pcb", dir: testDir });
    await writeFile(join(testDir, "subcircuits", "exp-pcb.tsx"), SIMPLE_SUBCIRCUIT, "utf-8");
    await subBuild({ name: "exp-pcb", dir: testDir });

    const result = await subExport({
      name: "exp-pcb",
      format: "kicad_pcb",
      dir: testDir,
    });

    expect(result.ok).toBe(true);
    expect(result.format).toBe("kicad_pcb");
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("kicad_pcb");
  });
});
