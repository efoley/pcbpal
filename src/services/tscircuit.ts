/**
 * tscircuit integration service.
 *
 * Compiles TSX subcircuit files to Circuit JSON, renders SVG previews,
 * and exports to KiCad format.
 */

import type { AnyCircuitElement } from "circuit-json";

export interface SubcircuitBuildResult {
  ok: boolean;
  name: string;
  circuitJson: AnyCircuitElement[];
  componentCount: number;
  netCount: number;
  errors: SubcircuitError[];
  warnings: SubcircuitWarning[];
}

export interface SubcircuitError {
  message: string;
  type: string;
}

export interface SubcircuitWarning {
  message: string;
  type: string;
}

/**
 * Dynamically import a TSX subcircuit file and compile it to Circuit JSON.
 *
 * Uses Bun.build() to transpile the TSX so that react/jsx-runtime resolves
 * from pcbpal's own node_modules, not the user's project directory.
 */
export async function buildSubcircuit(tsxPath: string, name: string): Promise<SubcircuitBuildResult> {
  const { RootCircuit } = await import("@tscircuit/core");
  const { createElement } = await import("react");

  // Transpile the TSX using Bun.build — this resolves react/jsx-runtime
  // from pcbpal's node_modules regardless of where the TSX file lives.
  const buildResult = await Bun.build({
    entrypoints: [tsxPath],
    target: "bun",
    // Keep dependencies external so we don't bundle all of tscircuit
    packages: "external",
  });

  if (!buildResult.success) {
    const msgs = buildResult.logs.map((l) => l.message ?? String(l));
    return {
      ok: false,
      name,
      circuitJson: [],
      componentCount: 0,
      netCount: 0,
      errors: msgs.map((m) => ({ message: m, type: "transpile_error" })),
      warnings: [],
    };
  }

  // Write the transpiled JS to a temp file alongside pcbpal's code
  // so that external imports (react, @tscircuit/core) resolve from
  // pcbpal's node_modules.
  const { join } = await import("node:path");
  const { writeFile, unlink } = await import("node:fs/promises");
  const tmpPath = join(import.meta.dirname, `__sub_build_${Date.now()}_${name}.mjs`);

  try {
    const jsCode = await buildResult.outputs[0].text();
    await writeFile(tmpPath, jsCode, "utf-8");
    const mod = await import(tmpPath);

    // The subcircuit should export a default component or a named export
    const Component = mod.default ?? mod[Object.keys(mod)[0]];
    if (!Component || typeof Component !== "function") {
      return {
        ok: false,
        name,
        circuitJson: [],
        componentCount: 0,
        netCount: 0,
        errors: [{ message: `No component exported from ${tsxPath}`, type: "no_export" }],
        warnings: [],
      };
    }

    const circuit = new RootCircuit();

    try {
      circuit.add(createElement(Component, {}));
      await circuit.renderUntilSettled();
    } catch (e) {
      return {
        ok: false,
        name,
        circuitJson: [],
        componentCount: 0,
        netCount: 0,
        errors: [{ message: (e as Error).message, type: "compile_error" }],
        warnings: [],
      };
    }

    const circuitJson = circuit.getCircuitJson();

    // Count components and nets
    const componentCount = circuitJson.filter(
      (el: any) => el.type === "source_component",
    ).length;
    const netCount = circuitJson.filter((el: any) => el.type === "source_net").length;

    // Extract any errors/warnings from the circuit JSON
    const errors: SubcircuitError[] = circuitJson
      .filter((el: any) => el.type === "pcb_error" || el.type === "schematic_error")
      .map((el: any) => ({
        message: el.message ?? el.error_type ?? "Unknown error",
        type: el.type,
      }));

    const warnings: SubcircuitWarning[] = circuitJson
      .filter((el: any) => el.type === "pcb_warning" || el.type === "schematic_warning")
      .map((el: any) => ({
        message: el.message ?? "Unknown warning",
        type: el.type,
      }));

    return {
      ok: errors.length === 0,
      name,
      circuitJson,
      componentCount,
      netCount,
      errors,
      warnings,
    };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

export type SvgView = "schematic" | "pcb" | "assembly";

/**
 * Render Circuit JSON to an SVG string.
 */
export async function renderCircuitSvg(
  circuitJson: AnyCircuitElement[],
  view: SvgView = "schematic",
): Promise<string> {
  const {
    convertCircuitJsonToSchematicSvg,
    convertCircuitJsonToPcbSvg,
    convertCircuitJsonToAssemblySvg,
  } = await import("circuit-to-svg");

  switch (view) {
    case "schematic":
      return convertCircuitJsonToSchematicSvg(circuitJson);
    case "pcb":
      return convertCircuitJsonToPcbSvg(circuitJson);
    case "assembly":
      return convertCircuitJsonToAssemblySvg(circuitJson);
  }
}

/**
 * Convert Circuit JSON to a KiCad schematic string (.kicad_sch).
 */
export async function convertToKicadSch(circuitJson: AnyCircuitElement[]): Promise<string> {
  const { CircuitJsonToKicadSchConverter } = await import("circuit-json-to-kicad");

  const converter = new CircuitJsonToKicadSchConverter(circuitJson);
  converter.runUntilFinished();
  return converter.getOutputString();
}

/**
 * Convert Circuit JSON to a KiCad PCB string (.kicad_pcb).
 */
export async function convertToKicadPcb(circuitJson: AnyCircuitElement[]): Promise<string> {
  const { CircuitJsonToKicadPcbConverter } = await import("circuit-json-to-kicad");

  const converter = new CircuitJsonToKicadPcbConverter(circuitJson);
  converter.runUntilFinished();
  return converter.getOutputString();
}
