/**
 * `datasheet diff` core — compare an extracted reference circuit against the
 * project's KiCad netlist. Presentation-free; cli.ts renders the result.
 *
 * The netlist → comparison path is factored into `diffAgainstNetlist` so it can
 * be unit-tested with a synthetic Netlist, no kicad-cli required.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatasheetExtraction } from "../../schemas/datasheet.js";
import type { Netlist } from "../../services/netlist.js";
import { exportNetlist } from "../../services/netlist.js";
import { findProjectRoot, readConfig } from "../../services/project.js";
import {
  type CircuitComparison,
  compareCircuits,
  fromKicadNetlist,
  fromReferenceCircuit,
} from "../../services/refcircuit-compare.js";

type CircuitExtraction = Extract<DatasheetExtraction, { facet: "circuit" }>;

export interface DiffOptions {
  file: string;
  refs?: string[];
  sheet?: string;
}

export interface DiffResult {
  ok: boolean; // ok = topologyPass
  device: string;
  comparedRefs: string[];
  comparison: CircuitComparison;
  hints: string[];
}

const isPowerSymbol = (ref: string): boolean => ref.startsWith("#");

/**
 * Auto-scope: find the KiCad component whose value/libPart contains the device
 * MPN, then take it plus its 1-hop net neighborhood (excluding power symbols).
 * Throws a helpful error listing candidates when the device cannot be located.
 */
function autoScope(device: string, netlist: Netlist): string[] {
  const needle = device.toLowerCase();
  const anchors = netlist.components.filter(
    (c) =>
      !isPowerSymbol(c.ref) &&
      (c.value.toLowerCase().includes(needle) || c.libPart.toLowerCase().includes(needle)),
  );

  if (anchors.length === 0) {
    const candidates = netlist.components
      .filter((c) => !isPowerSymbol(c.ref))
      .map((c) => `${c.ref} (${c.value || c.libPart || "?"})`)
      .join(", ");
    throw new Error(
      `Could not find a component matching device "${device}" in the schematic. ` +
        `Pass --refs to scope explicitly. Candidates: ${candidates || "none"}`,
    );
  }

  const anchorRefs = new Set(anchors.map((c) => c.ref));
  const scope = new Set<string>(anchorRefs);
  for (const net of netlist.nets) {
    const touchesAnchor = net.nodes.some((n) => anchorRefs.has(n.ref));
    if (!touchesAnchor) continue;
    for (const node of net.nodes) {
      if (!isPowerSymbol(node.ref)) scope.add(node.ref);
    }
  }
  return [...scope].sort();
}

/** Human-readable hints, templated mechanically from the top findings. */
function buildHints(comparison: CircuitComparison): string[] {
  const hints: string[] = [];
  for (const m of comparison.missingConnections) {
    hints.push(
      `datasheet net "${m.net}" connects ${m.pins.join(", ")}, but your schematic does not`,
    );
  }
  for (const v of comparison.valueMismatches) {
    hints.push(
      `datasheet ${v.goldenId} is ${v.goldenValue ?? "?"}, ` +
        `but schematic ${v.candidateId} is ${v.candidateValue ?? "?"}`,
    );
  }
  for (const id of comparison.unmatchedGolden) {
    hints.push(`datasheet component ${id} has no match in your schematic`);
  }
  for (const e of comparison.extraConnections) {
    hints.push(`schematic net "${e.net}" connects ${e.pins.join(", ")}, not in the datasheet`);
  }
  return hints.slice(0, 10);
}

/**
 * Pure comparison of a parsed circuit extraction against an already-exported
 * netlist. Testable without kicad-cli.
 */
export function diffAgainstNetlist(
  extraction: CircuitExtraction,
  netlist: Netlist,
  opts: { refs?: string[] },
): DiffResult {
  const device = extraction.device;
  const golden = fromReferenceCircuit(extraction.payload);

  const comparedRefs =
    opts.refs && opts.refs.length > 0 ? [...opts.refs].sort() : autoScope(device, netlist);

  const candidate = fromKicadNetlist(netlist, { refs: comparedRefs });
  const comparison = compareCircuits(golden, candidate);

  return {
    ok: comparison.metrics.topologyPass,
    device,
    comparedRefs,
    comparison,
    hints: buildHints(comparison),
  };
}

export async function diffCircuit(opts: DiffOptions): Promise<DiffResult> {
  let text: string;
  try {
    text = await readFile(opts.file, "utf-8");
  } catch {
    throw new Error(`Cannot read extraction file: ${opts.file}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Extraction file is not valid JSON: ${opts.file} (${(e as Error).message})`);
  }

  const parsed = DatasheetExtraction.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Extraction file failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  if (parsed.data.facet !== "circuit") {
    throw new Error(
      `datasheet diff requires a "circuit" extraction, but this file is "${parsed.data.facet}"`,
    );
  }
  const extraction = parsed.data;

  const root = await findProjectRoot();
  if (!root) throw new Error("Not in a pcbpal project (no pcbpal.toml found)");

  const config = await readConfig(root);
  if (!config.project.kicad_project) {
    throw new Error("No kicad_project configured in pcbpal.toml");
  }

  const schPath = join(root, config.project.kicad_project.replace(/\.kicad_pro$/, ".kicad_sch"));
  const netlist = await exportNetlist(schPath);

  return diffAgainstNetlist(extraction, netlist, { refs: opts.refs });
}
