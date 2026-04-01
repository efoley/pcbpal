import { exists } from "node:fs/promises";
import { join } from "node:path";
import { findProjectRoot, readBom, readConfig, readProduction } from "../../services/project.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

export interface DoctorResult {
  ok: boolean;
  root: string;
  checks: CheckResult[];
}

export async function runDoctor(): Promise<DoctorResult> {
  const checks: CheckResult[] = [];

  // Check 1: project root exists
  const root = await findProjectRoot();
  if (!root) {
    return {
      ok: false,
      root: process.cwd(),
      checks: [
        {
          name: "pcbpal project",
          ok: false,
          message: "No pcbpal.toml found — run `pcbpal init` first",
        },
      ],
    };
  }

  // Check 2: pcbpal.toml is valid
  try {
    const config = await readConfig(root);
    checks.push({
      name: "pcbpal.toml",
      ok: true,
      message: `Valid config for project "${config.project.name}"`,
    });

    // Check 3: KiCad project exists (if configured)
    if (config.project.kicad_project) {
      const kicadPath = join(root, config.project.kicad_project);
      const kicadExists = await exists(kicadPath);
      checks.push({
        name: "KiCad project",
        ok: kicadExists,
        message: kicadExists
          ? `Found ${config.project.kicad_project}`
          : `Missing: ${config.project.kicad_project}`,
      });
    }
  } catch (e) {
    checks.push({
      name: "pcbpal.toml",
      ok: false,
      message: `Invalid: ${(e as Error).message}`,
    });
  }

  // Check 4: BOM file
  try {
    const bom = await readBom(root);
    checks.push({
      name: "pcbpal.bom.json",
      ok: true,
      message: `Valid — ${bom.entries.length} entries`,
    });
  } catch (e) {
    const bomExists = await exists(join(root, "pcbpal.bom.json"));
    checks.push({
      name: "pcbpal.bom.json",
      ok: false,
      message: bomExists ? `Invalid: ${(e as Error).message}` : "Missing — run `pcbpal init`",
    });
  }

  // Check 5: Production file
  try {
    await readProduction(root);
    checks.push({
      name: "pcbpal.production.json",
      ok: true,
      message: "Valid",
    });
  } catch (e) {
    const prodExists = await exists(join(root, "pcbpal.production.json"));
    checks.push({
      name: "pcbpal.production.json",
      ok: false,
      message: prodExists ? `Invalid: ${(e as Error).message}` : "Missing — run `pcbpal init`",
    });
  }

  // Check 6: .pcbpal cache directory
  const cacheExists = await exists(join(root, ".pcbpal"));
  checks.push({
    name: ".pcbpal directory",
    ok: cacheExists,
    message: cacheExists ? "Exists" : "Missing — run `pcbpal init`",
  });

  // Check 7: easyeda2kicad available
  try {
    const e2kProc = Bun.spawn(["easyeda2kicad", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(e2kProc.stdout).text();
    const e2kExit = await e2kProc.exited;
    checks.push({
      name: "easyeda2kicad",
      ok: e2kExit === 0,
      message:
        e2kExit === 0
          ? "Found"
          : "easyeda2kicad returned an error",
    });
  } catch {
    checks.push({
      name: "easyeda2kicad",
      ok: false,
      message: "Not found — install with: pipx install easyeda2kicad",
    });
  }

  // Check 8: KiCad CLI available
  try {
    const proc = Bun.spawn(["kicad-cli", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    checks.push({
      name: "kicad-cli",
      ok: exitCode === 0,
      message: exitCode === 0 ? `Found: ${text.trim()}` : "kicad-cli returned an error",
    });
  } catch {
    checks.push({
      name: "kicad-cli",
      ok: false,
      message: "Not found — install KiCad 9+ for export features",
    });
  }

  const allOk = checks.every((c) => c.ok);

  return { ok: allOk, root, checks };
}
