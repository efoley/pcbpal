import { exists, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BomDatabase } from "../../schemas/bom.js";
import type { ProjectConfig } from "../../schemas/config.js";
import type { ProductionConfig } from "../../schemas/production.js";
import {
  ensureCacheDir,
  projectFilesExist,
  writeBom,
  writeConfig,
  writeProduction,
} from "../../services/project.js";
import { generateClaudeMd } from "./claude-md-template.js";

export interface InitOptions {
  dir: string;
  kicadProject?: string;
  noGit?: boolean;
}

export interface InitResult {
  ok: true;
  root: string;
  kicadProject: string | null;
  filesCreated: string[];
}

/** Scan directory for a .kicad_pro file */
async function findKicadProject(dir: string): Promise<string | null> {
  const entries = await readdir(dir);
  const kicadPro = entries.find((e) => e.endsWith(".kicad_pro"));
  return kicadPro ?? null;
}

export async function initProject(opts: InitOptions): Promise<InitResult> {
  const dir = opts.dir;
  const filesCreated: string[] = [];

  // Check if already initialized
  const existing = await projectFilesExist(dir);
  if (existing.config) {
    throw new Error("pcbpal.toml already exists — project is already initialized");
  }

  // Find KiCad project
  const kicadProject = opts.kicadProject ?? (await findKicadProject(dir));

  // Derive project name from KiCad project or directory name
  const projectName = kicadProject ? basename(kicadProject, ".kicad_pro") : basename(dir);

  // Create pcbpal.toml
  const config: ProjectConfig = {
    project: {
      name: projectName,
      version: "0.1.0",
      ...(kicadProject ? { kicad_project: kicadProject } : {}),
    },
  };
  await writeConfig(dir, config);
  filesCreated.push("pcbpal.toml");

  // Create empty pcbpal.bom.json
  const bom: BomDatabase = {
    schema_version: 1,
    entries: [],
  };
  await writeBom(dir, bom);
  filesCreated.push("pcbpal.bom.json");

  // Create pcbpal.production.json with defaults
  const production: ProductionConfig = {
    schema_version: 1,
    board: {
      thickness_mm: 1.6,
      min_trace_mm: 0.127,
      min_space_mm: 0.127,
      min_drill_mm: 0.3,
      min_via_diameter_mm: 0.6,
      surface_finish: "enig",
    },
    controlled_impedance: [],
    fabrication: {
      fab_house: "jlcpcb",
      quantity: 5,
      panelization: false,
      notes: [],
    },
    placement_corrections: [],
  };
  await writeProduction(dir, production);
  filesCreated.push("pcbpal.production.json");

  // Create .pcbpal/ cache directory
  await ensureCacheDir(dir);
  filesCreated.push(".pcbpal/");

  // Create .gitignore for .pcbpal/ unless --no-git
  if (!opts.noGit) {
    const gitignorePath = join(dir, ".pcbpal", ".gitignore");
    if (!(await exists(gitignorePath))) {
      await writeFile(gitignorePath, "*\n!.gitignore\n", "utf-8");
      filesCreated.push(".pcbpal/.gitignore");
    }
  }

  // Create CLAUDE.md if it doesn't already exist
  const claudeMdPath = join(dir, "CLAUDE.md");
  if (!(await exists(claudeMdPath))) {
    await writeFile(claudeMdPath, generateClaudeMd(projectName, kicadProject), "utf-8");
    filesCreated.push("CLAUDE.md");
  }

  return {
    ok: true,
    root: dir,
    kicadProject,
    filesCreated,
  };
}
