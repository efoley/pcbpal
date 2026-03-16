import { exists, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { BomDatabase } from "../schemas/bom.js";
import { ProjectConfig } from "../schemas/config.js";
import { ProductionConfig } from "../schemas/production.js";

const CONFIG_FILE = "pcbpal.toml";
const BOM_FILE = "pcbpal.bom.json";
const PRODUCTION_FILE = "pcbpal.production.json";
const CACHE_DIR = ".pcbpal";

/** Find the project root by looking for pcbpal.toml, walking up from cwd */
export async function findProjectRoot(from: string = process.cwd()): Promise<string | null> {
  let dir = from;
  while (true) {
    if (await exists(join(dir, CONFIG_FILE))) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Read and validate pcbpal.toml */
export async function readConfig(root: string): Promise<ProjectConfig> {
  const raw = await readFile(join(root, CONFIG_FILE), "utf-8");
  const parsed = TOML.parse(raw);
  return ProjectConfig.parse(parsed);
}

/** Write pcbpal.toml */
export async function writeConfig(root: string, config: ProjectConfig): Promise<void> {
  const toml = TOML.stringify(config as any);
  await writeFile(join(root, CONFIG_FILE), toml, "utf-8");
}

/** Read and validate pcbpal.bom.json */
export async function readBom(root: string): Promise<BomDatabase> {
  const raw = await readFile(join(root, BOM_FILE), "utf-8");
  return BomDatabase.parse(JSON.parse(raw));
}

/** Write pcbpal.bom.json */
export async function writeBom(root: string, bom: BomDatabase): Promise<void> {
  await writeFile(join(root, BOM_FILE), `${JSON.stringify(bom, null, 2)}\n`, "utf-8");
}

/** Read and validate pcbpal.production.json */
export async function readProduction(root: string): Promise<ProductionConfig> {
  const raw = await readFile(join(root, PRODUCTION_FILE), "utf-8");
  return ProductionConfig.parse(JSON.parse(raw));
}

/** Write pcbpal.production.json */
export async function writeProduction(root: string, config: ProductionConfig): Promise<void> {
  await writeFile(join(root, PRODUCTION_FILE), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

/** Ensure .pcbpal cache directory structure exists */
export async function ensureCacheDir(root: string): Promise<void> {
  const dirs = [
    CACHE_DIR,
    join(CACHE_DIR, "symbols"),
    join(CACHE_DIR, "footprints"),
    join(CACHE_DIR, "datasheets"),
    join(CACHE_DIR, "reviews"),
  ];
  for (const dir of dirs) {
    await mkdir(join(root, dir), { recursive: true });
  }
}

/** Check if the project files exist at the given root */
export async function projectFilesExist(root: string): Promise<{
  config: boolean;
  bom: boolean;
  production: boolean;
  cacheDir: boolean;
}> {
  return {
    config: await exists(join(root, CONFIG_FILE)),
    bom: await exists(join(root, BOM_FILE)),
    production: await exists(join(root, PRODUCTION_FILE)),
    cacheDir: await exists(join(root, CACHE_DIR)),
  };
}
