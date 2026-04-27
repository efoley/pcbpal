import { join } from "node:path";
import type { BomDatabase } from "../../schemas/bom.js";
import {
  type NetlistComponent,
  type NetlistNet,
  exportNetlist,
} from "../../services/netlist.js";
import { findProjectRoot, readBom, readConfig } from "../../services/project.js";

// ── Types ──

export interface FirmwareDatasheetOptions {
  /** MCU reference designator (e.g. "U2"). Auto-detected if omitted. */
  mcu?: string;
  /** Include test points. */
  includeTestPoints?: boolean;
  /** Read BOM from jlcpcb/project.db. */
  fromJlcpcb?: boolean;
}

export interface McuPin {
  pin: string; // physical pin number
  function: string; // e.g. "PA5", "VBAT", "NRST"
  pinType: string; // e.g. "bidirectional", "power_in"
  net: string; // net name
  purpose: string; // derived from BOM roles of connected components
  connectedTo: string[]; // e.g. ["R1.1", "U3.OUT"]
  sheet: string; // hierarchical sheet the net lives in
  isUnconnected: boolean;
}

export interface PowerRail {
  net: string;
  components: string[]; // refs connected to this rail
  description: string;
}

export interface DebugInterface {
  connector: string; // ref
  description: string;
  pins: { pin: string; net: string; function: string }[];
}

export interface FirmwareDatasheetResult {
  ok: true;
  projectName: string;
  mcu: { ref: string; value: string; description: string; footprint: string };
  pins: McuPin[];
  powerRails: PowerRail[];
  debugInterfaces: DebugInterface[];
  sheets: { name: string; nets: string[] }[];
  markdown: string;
}

// ── Helpers ──

const MCU_PATTERNS = [
  /stm32/i, /py32/i, /esp32/i, /rp2040/i, /rp2350/i,
  /nrf52/i, /nrf53/i, /nrf91/i,
  /atmega/i, /attiny/i, /samd/i, /sam[de]\d/i,
  /pic\d/i, /msp430/i, /ch32/i, /gd32/i,
];

function isMcu(comp: NetlistComponent): boolean {
  const text = `${comp.value} ${comp.description} ${comp.libPart}`;
  return MCU_PATTERNS.some((p) => p.test(text));
}

function detectMcu(components: NetlistComponent[]): NetlistComponent | null {
  const candidates = components.filter(isMcu);
  // Prefer the one with the most net connections (likely the main MCU)
  return candidates[0] ?? null;
}

/**
 * Derive a concise purpose annotation for a net from the BOM roles
 * and component descriptions of connected components.
 * Skips passives (caps, resistors) to focus on the meaningful connections.
 */
function derivePurpose(
  net: NetlistNet,
  mcuRef: string,
  componentMap: Map<string, NetlistComponent>,
  bomRoleMap: Map<string, string>,
): string {
  const passiveRefs = new Set<string>();
  const meaningful: string[] = [];

  for (const node of net.nodes) {
    if (node.ref === mcuRef) continue;
    const comp = componentMap.get(node.ref);
    if (!comp) continue;

    // Skip passives and test points for the purpose annotation
    const isPassive = /^(R|C|L|FB)\d/.test(node.ref);
    const isTestPoint = /^TP\d/.test(node.ref);
    if (isPassive) { passiveRefs.add(node.ref); continue; }
    if (isTestPoint) continue;

    const role = bomRoleMap.get(node.ref);
    if (role) {
      meaningful.push(role);
    } else {
      const fn = node.pinFunction ? `.${node.pinFunction}` : "";
      meaningful.push(`${node.ref}${fn} (${comp.value})`);
    }
  }

  const result = meaningful.join(", ");
  if (passiveRefs.size > 0 && meaningful.length === 0) {
    // Net only connects to passives — mention them briefly
    return `${[...passiveRefs].join(", ")}`;
  }
  return result;
}

/**
 * Determine which sheet a net belongs to, based on where its non-MCU nodes live.
 */
function netSheet(
  net: NetlistNet,
  mcuRef: string,
  componentMap: Map<string, NetlistComponent>,
): string {
  for (const node of net.nodes) {
    if (node.ref === mcuRef) continue;
    const comp = componentMap.get(node.ref);
    if (comp?.sheetName && comp.sheetName !== "/") return comp.sheetName;
  }
  return "/";
}

// ── Main ──

export async function firmwareDatasheet(
  opts: FirmwareDatasheetOptions = {},
): Promise<FirmwareDatasheetResult> {
  const root = await findProjectRoot();
  if (!root) throw new Error("Not in a pcbpal project (no pcbpal.toml found)");

  const config = await readConfig(root);
  if (!config.project.kicad_project) {
    throw new Error("No kicad_project configured in pcbpal.toml");
  }

  const schPath = join(root, config.project.kicad_project.replace(/\.kicad_pro$/, ".kicad_sch"));

  // Export and parse netlist
  const netlist = await exportNetlist(schPath);

  // Build lookup maps
  const componentMap = new Map(netlist.components.map((c) => [c.ref, c]));

  // Read BOM for role annotations
  const bomRoleMap = new Map<string, string>();
  try {
    let bom: BomDatabase;
    if (opts.fromJlcpcb) {
      const { readJlcpcbDb } = await import("../bom/check.js");
      bom = await readJlcpcbDb(root);
    } else {
      bom = await readBom(root);
    }
    for (const entry of bom.entries) {
      for (const ref of entry.kicad_refs) {
        bomRoleMap.set(ref, entry.role);
      }
    }
  } catch {
    // BOM may not exist — proceed without role annotations
  }

  // Detect MCU
  let mcuComp: NetlistComponent;
  if (opts.mcu) {
    const comp = componentMap.get(opts.mcu);
    if (!comp) throw new Error(`Component ${opts.mcu} not found in schematic`);
    mcuComp = comp;
  } else {
    const detected = detectMcu(netlist.components);
    if (!detected) {
      throw new Error(
        "Could not auto-detect MCU. Use --mcu <ref> to specify. Components: " +
          netlist.components
            .filter((c) => c.ref.startsWith("U"))
            .map((c) => `${c.ref} (${c.value})`)
            .join(", "),
      );
    }
    mcuComp = detected;
  }

  // Build MCU pin table
  const mcuNets = netlist.nets.filter((n) =>
    n.nodes.some((nd) => nd.ref === mcuComp.ref),
  );

  const pins: McuPin[] = [];
  for (const net of mcuNets) {
    const mcuNode = net.nodes.find((nd) => nd.ref === mcuComp.ref)!;
    const isUnconnected = net.name.startsWith("unconnected-");
    const others = net.nodes
      .filter((nd) => nd.ref !== mcuComp.ref)
      .map((nd) => {
        const fn = nd.pinFunction ? `.${nd.pinFunction}` : `.${nd.pin}`;
        return `${nd.ref}${fn}`;
      });

    pins.push({
      pin: mcuNode.pin,
      function: mcuNode.pinFunction || `pin${mcuNode.pin}`,
      pinType: mcuNode.pinType,
      net: isUnconnected ? "(unconnected)" : net.name,
      purpose: isUnconnected ? "" : derivePurpose(net, mcuComp.ref, componentMap, bomRoleMap),
      connectedTo: others,
      sheet: netSheet(net, mcuComp.ref, componentMap),
      isUnconnected,
    });
  }

  // Sort: power pins first, then by pin number
  pins.sort((a, b) => {
    if (a.pinType === "power_in" && b.pinType !== "power_in") return -1;
    if (a.pinType !== "power_in" && b.pinType === "power_in") return 1;
    return parseInt(a.pin) - parseInt(b.pin);
  });

  // Power rails
  const powerNets = netlist.nets.filter((n) => {
    const name = n.name.toLowerCase();
    return (
      name.startsWith("+") ||
      name === "gnd" ||
      name.includes("vdd") ||
      name.includes("vcc") ||
      name.includes("vbus") ||
      name.includes("3v3") ||
      name.includes("5v") ||
      name.includes("vref")
    );
  });

  const powerRails: PowerRail[] = powerNets.map((n) => ({
    net: n.name,
    components: n.nodes.map((nd) => nd.ref),
    description:
      n.nodes
        .filter((nd) => {
          const comp = componentMap.get(nd.ref);
          return comp && (comp.libPart.includes("Regulator") || comp.description.toLowerCase().includes("regulator"));
        })
        .map((nd) => {
          const comp = componentMap.get(nd.ref)!;
          return `${nd.ref} (${comp.value})`;
        })
        .join(", ") || "",
  }));

  // Debug interfaces
  const debugInterfaces: DebugInterface[] = [];
  const debugComps = netlist.components.filter((c) => {
    const text = `${c.value} ${c.description}`.toLowerCase();
    return text.includes("swd") || text.includes("jtag") || text.includes("tag-connect");
  });

  for (const dbg of debugComps) {
    const dbgNets = netlist.nets.filter((n) =>
      n.nodes.some((nd) => nd.ref === dbg.ref),
    );
    debugInterfaces.push({
      connector: dbg.ref,
      description: `${dbg.value} — ${dbg.description}`,
      pins: dbgNets.map((n) => {
        const node = n.nodes.find((nd) => nd.ref === dbg.ref)!;
        return { pin: node.pin, net: n.name, function: node.pinFunction || "" };
      }),
    });
  }

  // Sheets with their nets
  const sheetNets = new Map<string, Set<string>>();
  for (const net of netlist.nets) {
    if (net.name.startsWith("unconnected-")) continue;
    for (const node of net.nodes) {
      const comp = componentMap.get(node.ref);
      if (comp?.sheetName) {
        const existing = sheetNets.get(comp.sheetName) ?? new Set();
        existing.add(net.name);
        sheetNets.set(comp.sheetName, existing);
      }
    }
  }
  const sheets = [...sheetNets.entries()]
    .filter(([name]) => name !== "/")
    .map(([name, nets]) => ({ name, nets: [...nets].sort() }));

  // Generate markdown
  const markdown = generateMarkdown({
    projectName: config.project.name,
    mcu: mcuComp,
    pins,
    powerRails,
    debugInterfaces,
    sheets,
    includeTestPoints: opts.includeTestPoints,
  });

  return {
    ok: true,
    projectName: config.project.name,
    mcu: {
      ref: mcuComp.ref,
      value: mcuComp.value,
      description: mcuComp.description,
      footprint: mcuComp.footprint,
    },
    pins,
    powerRails,
    debugInterfaces,
    sheets,
    markdown,
  };
}

// ── Markdown generation ──

function generateMarkdown(data: {
  projectName: string;
  mcu: NetlistComponent;
  pins: McuPin[];
  powerRails: PowerRail[];
  debugInterfaces: DebugInterface[];
  sheets: { name: string; nets: string[] }[];
  includeTestPoints?: boolean;
}): string {
  const lines: string[] = [];
  const { mcu, pins, powerRails, debugInterfaces, sheets } = data;

  lines.push(`# ${data.projectName} — Firmware Reference`);
  lines.push("");
  lines.push(`## MCU: ${mcu.value} (${mcu.ref})`);
  lines.push("");
  lines.push(`- **Part:** ${mcu.value}`);
  lines.push(`- **Description:** ${mcu.description}`);
  lines.push(`- **Package:** ${mcu.footprint}`);
  lines.push("");

  // Pin table
  lines.push("## Pin Map");
  lines.push("");
  lines.push("| Pin | Function | Net | Purpose | Connected To |");
  lines.push("|-----|----------|-----|---------|-------------|");

  const signalPins = pins.filter((p) => !p.isUnconnected);
  for (const p of signalPins) {
    if (!data.includeTestPoints && p.connectedTo.every((c) => c.startsWith("TP"))) continue;
    const connected = p.connectedTo.join(", ");
    lines.push(`| ${p.pin} | ${p.function} | ${p.net} | ${p.purpose} | ${connected} |`);
  }
  lines.push("");


  // Power rails
  if (powerRails.length > 0) {
    lines.push("## Power Rails");
    lines.push("");
    lines.push("| Rail | Components | Source |");
    lines.push("|------|-----------|--------|");
    for (const rail of powerRails) {
      const comps = rail.components.length > 8
        ? `${rail.components.slice(0, 8).join(", ")}... (${rail.components.length} total)`
        : rail.components.join(", ");
      lines.push(`| ${rail.net} | ${comps} | ${rail.description} |`);
    }
    lines.push("");
  }

  // Debug interfaces
  if (debugInterfaces.length > 0) {
    lines.push("## Debug Interfaces");
    lines.push("");
    for (const dbg of debugInterfaces) {
      lines.push(`### ${dbg.connector}: ${dbg.description}`);
      lines.push("");
      lines.push("| Pin | Net | Function |");
      lines.push("|-----|-----|----------|");
      for (const p of dbg.pins) {
        lines.push(`| ${p.pin} | ${p.net} | ${p.function} |`);
      }
      lines.push("");
    }
  }

  // Subsystems
  if (sheets.length > 0) {
    lines.push("## Subsystems (Schematic Sheets)");
    lines.push("");
    for (const sheet of sheets) {
      lines.push(`### ${sheet.name}`);
      lines.push("");
      lines.push(`Nets: ${sheet.nets.join(", ")}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}
