import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { exists, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBom, readConfig, readProduction } from "../../services/project.js";
import { initProject } from "./core.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "pcbpal-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("initProject", () => {
  test("creates all project files in an empty directory", async () => {
    const result = await initProject({ dir: testDir });

    expect(result.ok).toBe(true);
    expect(result.filesCreated).toContain("pcbpal.toml");
    expect(result.filesCreated).toContain("pcbpal.bom.json");
    expect(result.filesCreated).toContain("pcbpal.production.json");
    expect(result.filesCreated).toContain(".pcbpal/");
    expect(result.filesCreated).toContain(".pcbpal/.gitignore");
    expect(result.filesCreated).toContain("CLAUDE.md");

    // Verify files are valid
    const config = await readConfig(testDir);
    expect(config.project.version).toBe("0.1.0");

    const bom = await readBom(testDir);
    expect(bom.schema_version).toBe(1);
    expect(bom.entries).toEqual([]);

    const prod = await readProduction(testDir);
    expect(prod.schema_version).toBe(1);
    expect(prod.board.surface_finish).toBe("enig");
  });

  test("detects .kicad_pro and uses it for project name", async () => {
    await writeFile(join(testDir, "my-board.kicad_pro"), "{}", "utf-8");

    const result = await initProject({ dir: testDir });

    expect(result.kicadProject).toBe("my-board.kicad_pro");
    const config = await readConfig(testDir);
    expect(config.project.name).toBe("my-board");
    expect(config.project.kicad_project).toBe("my-board.kicad_pro");
  });

  test("uses explicit --kicad-project option", async () => {
    const result = await initProject({
      dir: testDir,
      kicadProject: "custom.kicad_pro",
    });

    expect(result.kicadProject).toBe("custom.kicad_pro");
    const config = await readConfig(testDir);
    expect(config.project.kicad_project).toBe("custom.kicad_pro");
  });

  test("skips .gitignore with --no-git", async () => {
    const result = await initProject({ dir: testDir, noGit: true });

    expect(result.filesCreated).not.toContain(".pcbpal/.gitignore");
    expect(await exists(join(testDir, ".pcbpal", ".gitignore"))).toBe(false);
  });

  test("creates CLAUDE.md with project name and KiCad reference", async () => {
    await writeFile(join(testDir, "my-board.kicad_pro"), "{}", "utf-8");
    const result = await initProject({ dir: testDir });

    expect(result.filesCreated).toContain("CLAUDE.md");
    const content = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# my-board");
    expect(content).toContain("my-board.kicad_pro");
    expect(content).toContain("pcbpal");
  });

  test("does not overwrite existing CLAUDE.md", async () => {
    await writeFile(join(testDir, "CLAUDE.md"), "# My custom instructions\n", "utf-8");
    const result = await initProject({ dir: testDir });

    expect(result.filesCreated).not.toContain("CLAUDE.md");
    const content = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
    expect(content).toBe("# My custom instructions\n");
  });

  test("throws if already initialized", async () => {
    await initProject({ dir: testDir });

    expect(initProject({ dir: testDir })).rejects.toThrow("already initialized");
  });
});
