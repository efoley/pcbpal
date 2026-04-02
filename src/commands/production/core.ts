import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { PlacementCorrection } from "../../schemas/production.js";
import { readSchematicComponents } from "../../services/kicad.js";
import {
  findProjectRoot,
  readBom,
  readConfig,
  readProduction,
} from "../../services/project.js";

// ── Types ──

export interface ExportOptions {
  /** Output directory (default: .pcbpal/production/) */
  outputDir?: string;
  /** Read BOM from jlcpcb/project.db. */
  fromJlcpcb?: boolean;
  /** Use drill/place file origin. */
  useDrillOrigin?: boolean;
}

export interface ExportResult {
  ok: true;
  bomCsvPath: string;
  cplCsvPath: string;
  bomEntries: number;
  cplEntries: number;
  correctionsApplied: number;
}

// ── Position file parsing ──

interface PosEntry {
  ref: string;
  value: string;
  footprint: string;
  midX: number;
  midY: number;
  rotation: number;
  layer: string;
}

async function exportPositionCsv(
  pcbPath: string,
  useDrillOrigin: boolean,
): Promise<PosEntry[]> {
  const { tmpdir } = await import("node:os");
  const tmpFile = join(tmpdir(), `pcbpal-pos-${Date.now()}.csv`);

  const args = [
    "kicad-cli",
    "pcb",
    "export",
    "pos",
    pcbPath,
    "--format",
    "csv",
    "--units",
    "mm",
    "--side",
    "both",
    "--smd-only",
    "--exclude-dnp",
    "-o",
    tmpFile,
  ];
  if (useDrillOrigin) args.push("--use-drill-file-origin");

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`kicad-cli pos export failed: ${stderr.trim()}`);
  }

  const csv = await readFile(tmpFile, "utf-8");
  await import("node:fs/promises").then((fs) => fs.unlink(tmpFile).catch(() => {}));

  // Parse CSV — kicad-cli outputs: Ref,Val,Package,PosX,PosY,Rot,Side
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    return {
      ref: cols[0]?.trim().replace(/"/g, "") ?? "",
      value: cols[1]?.trim().replace(/"/g, "") ?? "",
      footprint: cols[2]?.trim().replace(/"/g, "") ?? "",
      midX: parseFloat(cols[3]) || 0,
      midY: parseFloat(cols[4]) || 0,
      rotation: parseFloat(cols[5]) || 0,
      layer: (cols[6]?.trim().replace(/"/g, "") ?? "").toLowerCase().includes("bottom")
        ? "bottom"
        : "top",
    };
  });
}

// ── Correction application ──

function applyCorrections(
  entry: PosEntry,
  corrections: PlacementCorrection[],
): { rotation: number; offsetX: number; offsetY: number; matched: string | null } {
  let rotation = entry.rotation;
  let offsetX = 0;
  let offsetY = 0;
  let matched: string | null = null;

  for (const corr of corrections) {
    const regex = new RegExp(corr.pattern, "i");
    const target =
      corr.match_on === "reference"
        ? entry.ref
        : corr.match_on === "value"
          ? entry.value
          : entry.footprint;

    if (regex.test(target)) {
      rotation = (rotation + corr.rotation) % 360;
      offsetX += corr.offset_x;
      offsetY += corr.offset_y;
      matched = corr.pattern;
      break; // First match wins
    }
  }

  return { rotation, offsetX, offsetY, matched };
}

// ── BOM CSV generation ──

interface BomCsvRow {
  comment: string;
  designators: string;
  footprint: string;
  lcsc: string;
  quantity: number;
}

function buildBomCsv(
  refToLcsc: Map<string, string>,
  positions: PosEntry[],
): BomCsvRow[] {
  // Group by LCSC part number
  const byLcsc = new Map<string, { refs: string[]; value: string; footprint: string }>();

  for (const pos of positions) {
    const lcsc = refToLcsc.get(pos.ref);
    if (!lcsc) continue;

    const group = byLcsc.get(lcsc) ?? { refs: [], value: pos.value, footprint: pos.footprint };
    group.refs.push(pos.ref);
    byLcsc.set(lcsc, group);
  }

  const rows: BomCsvRow[] = [];
  for (const [lcsc, group] of byLcsc) {
    rows.push({
      comment: group.value,
      designators: group.refs.sort().join(","),
      footprint: group.footprint,
      lcsc,
      quantity: group.refs.length,
    });
  }

  return rows.sort((a, b) => a.comment.localeCompare(b.comment));
}

// ── Main export ──

export async function productionExport(opts: ExportOptions = {}): Promise<ExportResult> {
  const root = await findProjectRoot();
  if (!root) throw new Error("Not in a pcbpal project (no pcbpal.toml found)");

  const config = await readConfig(root);
  if (!config.project.kicad_project) {
    throw new Error("No kicad_project configured in pcbpal.toml");
  }

  // Find the .kicad_pcb file (same name as .kicad_pro but with .kicad_pcb extension)
  const pcbPath = join(root, config.project.kicad_project.replace(/\.kicad_pro$/, ".kicad_pcb"));

  // Read placement corrections from production config
  let corrections: PlacementCorrection[] = [];
  try {
    const prod = await readProduction(root);
    corrections = prod.placement_corrections ?? [];
  } catch {
    // No production config or invalid — proceed without corrections
  }

  // Build ref→LCSC mapping
  const refToLcsc = new Map<string, string>();
  if (opts.fromJlcpcb) {
    const { readJlcpcbDb } = await import("../bom/check.js");
    const bom = await readJlcpcbDb(root);
    for (const entry of bom.entries) {
      const lcsc = entry.sources.find((s) => s.supplier === "lcsc")?.part_number;
      if (lcsc) {
        for (const ref of entry.kicad_refs) refToLcsc.set(ref, lcsc);
      }
    }
  } else {
    const bom = await readBom(root);
    for (const entry of bom.entries) {
      const lcsc = entry.sources.find((s) => s.supplier === "lcsc")?.part_number;
      if (lcsc) {
        for (const ref of entry.kicad_refs) refToLcsc.set(ref, lcsc);
      }
    }
  }

  // Export positions from KiCad
  const positions = await exportPositionCsv(pcbPath, opts.useDrillOrigin ?? false);

  // Generate output
  const outDir = opts.outputDir ?? join(root, ".pcbpal", "production");
  await mkdir(outDir, { recursive: true });

  const projectName = basename(config.project.kicad_project, ".kicad_pro");

  // Generate CPL CSV
  let correctionsApplied = 0;
  const cplLines = ["Designator,Val,Package,Mid X,Mid Y,Rotation,Layer"];
  for (const pos of positions) {
    const corrected = applyCorrections(pos, corrections);
    if (corrected.matched) correctionsApplied++;

    const midX = (pos.midX + corrected.offsetX).toFixed(4);
    // JLCPCB expects Y-axis inverted
    const midY = ((pos.midY + corrected.offsetY) * -1).toFixed(4);
    const rotation = corrected.rotation.toFixed(1);

    cplLines.push(
      `${pos.ref},${pos.value},${pos.footprint},${midX},${midY},${rotation},${pos.layer}`,
    );
  }

  const cplPath = join(outDir, `CPL-${projectName}.csv`);
  await writeFile(cplPath, cplLines.join("\n") + "\n", "utf-8");

  // Generate BOM CSV
  const bomRows = buildBomCsv(refToLcsc, positions);
  const bomLines = ["Comment,Designator,Footprint,LCSC,Quantity"];
  for (const row of bomRows) {
    bomLines.push(
      `${row.comment},"${row.designators}",${row.footprint},${row.lcsc},${row.quantity}`,
    );
  }

  const bomPath = join(outDir, `BOM-${projectName}.csv`);
  await writeFile(bomPath, bomLines.join("\n") + "\n", "utf-8");

  return {
    ok: true,
    bomCsvPath: bomPath,
    cplCsvPath: cplPath,
    bomEntries: bomRows.length,
    cplEntries: positions.length,
    correctionsApplied,
  };
}
