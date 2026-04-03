import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { readSchematicComponents } from "../../services/kicad.js";
import {
  findProjectRoot,
  readBom,
  readConfig,
  readProduction,
} from "../../services/project.js";

// ── Types ──

export type ReviewTarget = "schematic" | "pcb" | "bom" | "drc";

export interface ReviewOptions {
  target: ReviewTarget;
  /** Specific schematic sheet (for "schematic" target). */
  sheet?: string;
  /** Include additional context files (datasheets, app notes). */
  contextFiles?: string[];
  /** Read BOM from jlcpcb/project.db. */
  fromJlcpcb?: boolean;
}

export interface ReviewContext {
  ok: true;
  target: ReviewTarget;
  outputDir: string;
  /** Paths to exported SVG images. */
  images: string[];
  /** Path to context.json summary. */
  contextJsonPath: string;
  /** The context data itself. */
  context: ReviewContextData;
}

export interface ReviewContextData {
  project: string;
  target: ReviewTarget;
  timestamp: string;
  images: string[];
  schematicComponents?: { ref: string; value: string; footprint: string }[];
  bom?: {
    entries: number;
    withLcsc: number;
    withoutSource: number;
    candidates: number;
    summary: { role: string; refs: string[]; lcsc: string | null; status: string }[];
  };
  drc?: {
    violations: number;
    unconnected: number;
    details: unknown[];
  };
  production?: {
    boardThickness?: number;
    surfaceFinish?: string;
    layerCount?: number;
    impedanceProfiles?: number;
    placementCorrections?: number;
  };
  additionalContext?: string[];
}

// ── Helpers ──

async function runKicadCli(args: string[], outFile?: string): Promise<string> {
  const proc = Bun.spawn(["kicad-cli", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // DRC returns non-zero when violations exist — that's expected
  if (exitCode !== 0 && !args.includes("drc")) {
    throw new Error(`kicad-cli ${args[0]} ${args[1]} failed: ${stderr.trim() || stdout.trim()}`);
  }

  if (outFile) {
    return readFile(outFile, "utf-8");
  }
  return stdout;
}

// ── Target exporters ──

async function exportSchematic(
  root: string,
  schPath: string,
  outDir: string,
  sheet?: string,
): Promise<string[]> {
  const args = [
    "sch", "export", "svg",
    schPath,
    "-o", outDir + "/",
    "--no-background-color",
    "--exclude-drawing-sheet",
  ];
  if (sheet) args.push("--pages", sheet);

  await runKicadCli(args);

  const { readdir } = await import("node:fs/promises");
  const files = await readdir(outDir);
  return files.filter((f) => f.endsWith(".svg")).map((f) => join(outDir, f));
}

async function exportPcbSvg(
  pcbPath: string,
  outDir: string,
): Promise<string[]> {
  const svgPath = join(outDir, "pcb-layout.svg");
  await runKicadCli([
    "pcb", "export", "svg",
    pcbPath,
    "-o", svgPath,
    "--layers", "F.Cu,B.Cu,F.SilkS,B.SilkS,F.Mask,Edge.Cuts",
    "--page-size-mode", "2",
    "--exclude-drawing-sheet",
  ]);
  return [svgPath];
}

async function exportDrc(
  pcbPath: string,
  outDir: string,
): Promise<{ path: string; data: unknown }> {
  const drcPath = join(outDir, "drc.json");
  await runKicadCli([
    "pcb", "drc",
    pcbPath,
    "--format", "json",
    "--severity-all",
    "--units", "mm",
    "-o", drcPath,
  ]);
  const content = await readFile(drcPath, "utf-8");
  return { path: drcPath, data: JSON.parse(content) };
}

async function buildBomSummary(
  root: string,
  fromJlcpcb: boolean,
): Promise<ReviewContextData["bom"]> {
  let bom;
  if (fromJlcpcb) {
    const { readJlcpcbDb } = await import("../bom/check.js");
    bom = await readJlcpcbDb(root);
  } else {
    bom = await readBom(root);
  }

  const withLcsc = bom.entries.filter((e) =>
    e.sources.some((s) => s.supplier === "lcsc"),
  ).length;
  const withoutSource = bom.entries.filter((e) => e.sources.length === 0).length;
  const candidates = bom.entries.filter((e) => e.status === "candidate").length;

  return {
    entries: bom.entries.length,
    withLcsc,
    withoutSource,
    candidates,
    summary: bom.entries.map((e) => ({
      role: e.role,
      refs: e.kicad_refs,
      lcsc: e.sources.find((s) => s.supplier === "lcsc")?.part_number ?? null,
      status: e.status,
    })),
  };
}

async function buildProductionSummary(
  root: string,
): Promise<ReviewContextData["production"] | undefined> {
  try {
    const prod = await readProduction(root);
    return {
      boardThickness: prod.board.thickness_mm,
      surfaceFinish: prod.board.surface_finish,
      layerCount: prod.stackup?.layer_count,
      impedanceProfiles: prod.controlled_impedance.length,
      placementCorrections: prod.placement_corrections.length,
    };
  } catch {
    return undefined;
  }
}

// ── Main ──

export async function reviewPrepare(
  opts: ReviewOptions,
  onProgress?: (msg: string) => void,
): Promise<ReviewContext> {
  const root = await findProjectRoot();
  if (!root) throw new Error("Not in a pcbpal project (no pcbpal.toml found)");

  const config = await readConfig(root);
  if (!config.project.kicad_project) {
    throw new Error("No kicad_project configured in pcbpal.toml");
  }

  const projectName = basename(config.project.kicad_project, ".kicad_pro");
  const schPath = join(root, config.project.kicad_project.replace(/\.kicad_pro$/, ".kicad_sch"));
  const pcbPath = join(root, config.project.kicad_project.replace(/\.kicad_pro$/, ".kicad_pcb"));

  const outDir = join(root, ".pcbpal", "review");
  // Clean previous review output
  const { rm } = await import("node:fs/promises");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const images: string[] = [];
  const contextData: ReviewContextData = {
    project: projectName,
    target: opts.target,
    timestamp: new Date().toISOString(),
    images: [],
  };

  // Always include schematic components and BOM summary as baseline context
  onProgress?.("Reading schematic components...");
  try {
    const components = await readSchematicComponents(root);
    contextData.schematicComponents = components.map((c) => ({
      ref: c.ref,
      value: c.value,
      footprint: c.footprint,
    }));
  } catch {
    // Schematic may not exist for some targets
  }

  onProgress?.("Reading BOM...");
  try {
    contextData.bom = await buildBomSummary(root, opts.fromJlcpcb ?? false);
  } catch {
    // BOM may be empty or missing
  }

  contextData.production = await buildProductionSummary(root);

  // Target-specific exports
  switch (opts.target) {
    case "schematic": {
      onProgress?.("Exporting schematic SVGs...");
      const svgs = await exportSchematic(root, schPath, outDir, opts.sheet);
      images.push(...svgs);
      break;
    }
    case "pcb": {
      onProgress?.("Exporting PCB SVG...");
      const svgs = await exportPcbSvg(pcbPath, outDir);
      images.push(...svgs);
      break;
    }
    case "drc": {
      onProgress?.("Running DRC...");
      const { data } = await exportDrc(pcbPath, outDir);
      const drcData = data as any;
      contextData.drc = {
        violations: drcData.violations?.length ?? 0,
        unconnected: drcData.unconnected_items?.length ?? 0,
        details: drcData.violations ?? [],
      };
      // Also export PCB SVG for visual reference
      onProgress?.("Exporting PCB SVG...");
      const svgs = await exportPcbSvg(pcbPath, outDir);
      images.push(...svgs);
      break;
    }
    case "bom": {
      // BOM summary already built above — no extra exports needed
      // Optionally export schematic for visual reference
      onProgress?.("Exporting schematic SVGs...");
      try {
        const svgs = await exportSchematic(root, schPath, outDir);
        images.push(...svgs);
      } catch {
        // Schematic export is optional for BOM review
      }
      break;
    }
  }

  // Include additional context files
  if (opts.contextFiles?.length) {
    contextData.additionalContext = opts.contextFiles;
  }

  contextData.images = images;

  // Write context.json
  const contextJsonPath = join(outDir, "context.json");
  await writeFile(contextJsonPath, JSON.stringify(contextData, null, 2), "utf-8");

  return {
    ok: true,
    target: opts.target,
    outputDir: outDir,
    images,
    contextJsonPath,
    context: contextData,
  };
}
