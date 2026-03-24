import { exists, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { findProjectRoot } from "../../services/project.js";
import {
  type SubcircuitBuildResult,
  type SvgView,
  buildSubcircuit,
  convertToKicadPcb,
  convertToKicadSch,
  renderCircuitSvg,
} from "../../services/tscircuit.js";

// ── sub new ──

export interface SubNewOptions {
  name: string;
  dir?: string;
}

export interface SubNewResult {
  ok: true;
  path: string;
  name: string;
}

const SUBCIRCUIT_TEMPLATE = `/**
 * @pcbpal subcircuit
 * @role TODO: describe what this subcircuit does
 * @interface
 *   VCC: power input
 *   GND: ground
 *   OUT: output signal
 */
import { useResistor, useCapacitor } from "@tscircuit/core"

export const {{COMPONENT_NAME}} = () => (
  <board width="10mm" height="10mm">
    {/* Add components and traces here */}
  </board>
)

export default {{COMPONENT_NAME}}
`;

function toComponentName(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

export async function subNew(opts: SubNewOptions): Promise<SubNewResult> {
  const root = opts.dir ?? (await findProjectRoot());
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }

  const subcircuitsDir = join(root, "subcircuits");
  if (!(await exists(subcircuitsDir))) {
    await mkdir(subcircuitsDir, { recursive: true });
  }

  const filePath = join(subcircuitsDir, `${opts.name}.tsx`);
  if (await exists(filePath)) {
    throw new Error(`Subcircuit already exists: subcircuits/${opts.name}.tsx`);
  }

  const componentName = toComponentName(opts.name);
  const content = SUBCIRCUIT_TEMPLATE.replaceAll("{{COMPONENT_NAME}}", componentName);
  await writeFile(filePath, content, "utf-8");

  return { ok: true, path: filePath, name: opts.name };
}

// ── sub list ──

export interface SubListEntry {
  name: string;
  path: string;
  hasCircuitJson: boolean;
}

export interface SubListResult {
  subcircuits: SubListEntry[];
  total: number;
}

export async function subList(dir?: string): Promise<SubListResult> {
  const root = dir ?? (await findProjectRoot());
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }

  const subcircuitsDir = join(root, "subcircuits");
  if (!(await exists(subcircuitsDir))) {
    return { subcircuits: [], total: 0 };
  }

  const entries = await readdir(subcircuitsDir);
  const tsxFiles = entries.filter((e) => e.endsWith(".tsx"));

  const subcircuits: SubListEntry[] = await Promise.all(
    tsxFiles.map(async (file) => {
      const name = basename(file, ".tsx");
      const circuitJsonPath = join(root, ".pcbpal", "builds", `${name}.circuit.json`);
      return {
        name,
        path: join(subcircuitsDir, file),
        hasCircuitJson: await exists(circuitJsonPath),
      };
    }),
  );

  return { subcircuits, total: subcircuits.length };
}

// ── sub build ──

export interface SubBuildOptions {
  name?: string;
  all?: boolean;
  dir?: string;
}

export interface SubBuildResult {
  results: SubcircuitBuildResult[];
  total: number;
  ok: boolean;
}

export async function subBuild(opts: SubBuildOptions): Promise<SubBuildResult> {
  const root = opts.dir ?? (await findProjectRoot());
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }

  // Determine which subcircuits to build
  let names: string[];
  if (opts.all) {
    const list = await subList(root);
    names = list.subcircuits.map((s) => s.name);
    if (names.length === 0) {
      throw new Error("No subcircuits found in subcircuits/");
    }
  } else if (opts.name) {
    names = [opts.name];
  } else {
    throw new Error("Specify a subcircuit name or --all");
  }

  // Ensure builds directory exists
  const buildsDir = join(root, ".pcbpal", "builds");
  if (!(await exists(buildsDir))) {
    await mkdir(buildsDir, { recursive: true });
  }

  const results: SubcircuitBuildResult[] = [];

  for (const name of names) {
    const tsxPath = resolve(join(root, "subcircuits", `${name}.tsx`));
    if (!(await exists(tsxPath))) {
      results.push({
        ok: false,
        name,
        circuitJson: [],
        componentCount: 0,
        netCount: 0,
        errors: [{ message: `File not found: subcircuits/${name}.tsx`, type: "not_found" }],
        warnings: [],
      });
      continue;
    }

    const result = await buildSubcircuit(tsxPath, name);
    results.push(result);

    // Save Circuit JSON on success
    if (result.ok || result.circuitJson.length > 0) {
      const outPath = join(buildsDir, `${name}.circuit.json`);
      await writeFile(outPath, JSON.stringify(result.circuitJson, null, 2), "utf-8");
    }
  }

  return {
    results,
    total: results.length,
    ok: results.every((r) => r.ok),
  };
}

// ── sub preview ──

export interface SubPreviewOptions {
  name: string;
  view?: SvgView;
  output?: string;
  dir?: string;
}

export interface SubPreviewResult {
  ok: true;
  path: string;
  view: SvgView;
  name: string;
}

export async function subPreview(opts: SubPreviewOptions): Promise<SubPreviewResult> {
  const root = opts.dir ?? (await findProjectRoot());
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }

  const view = opts.view ?? "schematic";

  // Check for existing build, or build now
  const circuitJsonPath = join(root, ".pcbpal", "builds", `${opts.name}.circuit.json`);
  let circuitJson: any[];

  if (await exists(circuitJsonPath)) {
    const raw = await readFile(circuitJsonPath, "utf-8");
    circuitJson = JSON.parse(raw);
  } else {
    // Build first
    const buildResult = await subBuild({ name: opts.name, dir: root });
    if (!buildResult.ok) {
      const errors = buildResult.results
        .flatMap((r) => r.errors)
        .map((e) => e.message)
        .join(", ");
      throw new Error(`Build failed: ${errors}`);
    }
    circuitJson = buildResult.results[0].circuitJson;
  }

  const svg = await renderCircuitSvg(circuitJson, view);

  // Write SVG to output path
  const previewDir = join(root, ".pcbpal", "preview");
  if (!(await exists(previewDir))) {
    await mkdir(previewDir, { recursive: true });
  }

  const outPath = opts.output ?? join(previewDir, `${opts.name}-${view}.svg`);
  await writeFile(outPath, svg, "utf-8");

  return { ok: true, path: outPath, view, name: opts.name };
}

// ── sub export ──

export interface SubExportOptions {
  name: string;
  format?: "kicad_sch" | "kicad_pcb";
  output?: string;
  dir?: string;
}

export interface SubExportResult {
  ok: true;
  path: string;
  format: string;
  name: string;
}

export async function subExport(opts: SubExportOptions): Promise<SubExportResult> {
  const root = opts.dir ?? (await findProjectRoot());
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }

  const format = opts.format ?? "kicad_sch";

  // Check for existing build, or build now
  const circuitJsonPath = join(root, ".pcbpal", "builds", `${opts.name}.circuit.json`);
  let circuitJson: any[];

  if (await exists(circuitJsonPath)) {
    const raw = await readFile(circuitJsonPath, "utf-8");
    circuitJson = JSON.parse(raw);
  } else {
    const buildResult = await subBuild({ name: opts.name, dir: root });
    if (!buildResult.ok) {
      const errors = buildResult.results
        .flatMap((r) => r.errors)
        .map((e) => e.message)
        .join(", ");
      throw new Error(`Build failed: ${errors}`);
    }
    circuitJson = buildResult.results[0].circuitJson;
  }

  let content: string;
  let ext: string;

  if (format === "kicad_sch") {
    content = await convertToKicadSch(circuitJson);
    ext = ".kicad_sch";
  } else {
    content = await convertToKicadPcb(circuitJson);
    ext = ".kicad_pcb";
  }

  const outPath = opts.output ?? join(root, `${opts.name}${ext}`);
  await writeFile(outPath, content, "utf-8");

  return { ok: true, path: outPath, format, name: opts.name };
}
