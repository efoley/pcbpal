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
  source: string; // regulator/connector that supplies this rail
  loads: string[]; // ICs fed by this rail (not passives)
}

export interface ConnectorInfo {
  ref: string;
  description: string;
  pins: { pin: string; net: string; function: string }[];
}

export interface FirmwareDatasheetResult {
  ok: true;
  projectName: string;
  mcu: { ref: string; value: string; description: string; footprint: string };
  pins: McuPin[];
  freeGpios: McuPin[];
  powerRails: PowerRail[];
  debugInterfaces: ConnectorInfo[];
  connectors: ConnectorInfo[];
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
  return candidates[0] ?? null;
}

function isPassiveRef(ref: string): boolean {
  return /^(R|C|L|FB)\d/.test(ref);
}

function isTestPointRef(ref: string): boolean {
  return /^TP\d/.test(ref);
}

/**
 * Derive a concise purpose annotation for a net.
 * Skips passives and test points to focus on meaningful ICs/connectors.
 */
function derivePurpose(
  net: NetlistNet,
  mcuRef: string,
  componentMap: Map<string, NetlistComponent>,
  bomRoleMap: Map<string, string>,
): string {
  const passiveRefs: string[] = [];
  const meaningful: string[] = [];

  for (const node of net.nodes) {
    if (node.ref === mcuRef) continue;
    const comp = componentMap.get(node.ref);
    if (!comp) continue;

    if (isPassiveRef(node.ref)) { passiveRefs.push(node.ref); continue; }
    if (isTestPointRef(node.ref)) continue;

    const role = bomRoleMap.get(node.ref);
    if (role) {
      meaningful.push(role);
    } else {
      const fn = node.pinFunction ? `.${node.pinFunction}` : "";
      meaningful.push(`${node.ref}${fn} (${comp.value})`);
    }
  }

  if (meaningful.length > 0) return meaningful.join(", ");
  if (passiveRefs.length > 0) return passiveRefs.join(", ");
  return "";
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

/**
 * Identify the source of a power rail — look for regulators, converters,
 * and connectors with power_out pins on this net.
 */
function identifyPowerSource(
  net: NetlistNet,
  componentMap: Map<string, NetlistComponent>,
): string {
  for (const node of net.nodes) {
    // Pin explicitly marked as power output
    if (node.pinType === "power_out") {
      const comp = componentMap.get(node.ref);
      if (comp) return `${node.ref} (${comp.value})`;
    }
  }

  for (const node of net.nodes) {
    const comp = componentMap.get(node.ref);
    if (!comp) continue;
    const text = `${comp.description} ${comp.libPart}`.toLowerCase();
    // Regulator/converter output pins
    if (text.includes("regulator") || text.includes("converter") || text.includes("boost") || text.includes("buck")) {
      const fn = node.pinFunction?.toLowerCase() ?? "";
      if (fn.includes("out") || fn.includes("vo") || fn.includes("sw")) {
        return `${node.ref} (${comp.value})`;
      }
    }
    // USB connector supplying VBUS
    if (node.ref.startsWith("J") && net.name.toLowerCase().includes("vbus")) {
      return `${node.ref} (${comp.value})`;
    }
  }

  return "";
}

function isConnector(comp: NetlistComponent): boolean {
  if (isTestPointRef(comp.ref)) return false;
  const text = `${comp.value} ${comp.description} ${comp.libPart}`.toLowerCase();
  return comp.ref.startsWith("J") || text.includes("connector") || text.includes("receptacle") || text.includes("header");
}

function isDebugConnector(comp: NetlistComponent): boolean {
  const text = `${comp.value} ${comp.description}`.toLowerCase();
  return text.includes("swd") || text.includes("jtag") || text.includes("tag-connect");
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

  const netlist = await exportNetlist(schPath);
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
    // BOM may not exist
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

  // Sort by pin number
  pins.sort((a, b) => parseInt(a.pin) - parseInt(b.pin));

  const freeGpios = pins.filter((p) => p.isUnconnected);

  // Power rails
  const powerNetNames = new Set<string>();
  const powerNets = netlist.nets.filter((n) => {
    const name = n.name.toLowerCase();
    const isPower =
      name.startsWith("+") ||
      name === "gnd" ||
      name.includes("vdd") ||
      name.includes("vcc") ||
      name.includes("vbus") ||
      name.includes("3v3") ||
      name.includes("5v") ||
      name.includes("vref");
    if (isPower) powerNetNames.add(n.name);
    return isPower;
  });

  const powerRails: PowerRail[] = powerNets.map((n) => {
    const loads = n.nodes
      .filter((nd) => {
        const comp = componentMap.get(nd.ref);
        return comp && !isPassiveRef(nd.ref) && !isTestPointRef(nd.ref);
      })
      .map((nd) => nd.ref);
    // Deduplicate (same ref may appear multiple times for multi-pin power)
    const uniqueLoads = [...new Set(loads)];

    return {
      net: n.name,
      source: identifyPowerSource(n, componentMap),
      loads: uniqueLoads,
    };
  });

  // Connectors — debug and non-debug
  const debugInterfaces: ConnectorInfo[] = [];
  const connectors: ConnectorInfo[] = [];

  const allConnectors = netlist.components.filter(isConnector);
  for (const conn of allConnectors) {
    const connNets = netlist.nets.filter((n) =>
      n.nodes.some((nd) => nd.ref === conn.ref),
    );
    const info: ConnectorInfo = {
      ref: conn.ref,
      description: `${conn.value} — ${conn.description}`,
      pins: connNets.map((n) => {
        const node = n.nodes.find((nd) => nd.ref === conn.ref)!;
        return { pin: node.pin, net: n.name, function: node.pinFunction || "" };
      }),
    };

    if (isDebugConnector(conn)) {
      debugInterfaces.push(info);
    } else {
      connectors.push(info);
    }
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

  const markdown = generateMarkdown({
    projectName: config.project.name,
    mcu: mcuComp,
    pins,
    freeGpios,
    powerRails,
    powerNetNames,
    debugInterfaces,
    connectors,
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
    freeGpios,
    powerRails,
    debugInterfaces,
    connectors,
    sheets,
    markdown,
  };
}

// ── Markdown generation ──

function generateMarkdown(data: {
  projectName: string;
  mcu: NetlistComponent;
  pins: McuPin[];
  freeGpios: McuPin[];
  powerRails: PowerRail[];
  powerNetNames: Set<string>;
  debugInterfaces: ConnectorInfo[];
  connectors: ConnectorInfo[];
  sheets: { name: string; nets: string[] }[];
  includeTestPoints?: boolean;
}): string {
  const lines: string[] = [];
  const { mcu, pins, freeGpios, powerRails, powerNetNames, debugInterfaces, connectors, sheets } = data;

  lines.push(`# ${data.projectName} — Firmware Reference`);
  lines.push("");
  lines.push(`## MCU: ${mcu.value} (${mcu.ref})`);
  lines.push("");
  lines.push(`- **Part:** ${mcu.value}`);
  if (mcu.description) lines.push(`- **Description:** ${mcu.description}`);
  lines.push(`- **Package:** ${mcu.footprint}`);
  lines.push("");

  // Signal pin table (exclude power/GND — those go in power rails section)
  const signalPins = pins.filter((p) => !p.isUnconnected && !powerNetNames.has(p.net));
  if (signalPins.length > 0) {
    lines.push("## Pin Map");
    lines.push("");
    lines.push("| Pin | Function | Net | Purpose | Connected To |");
    lines.push("|-----|----------|-----|---------|-------------|");
    for (const p of signalPins) {
      const connected = p.connectedTo.join(", ");
      lines.push(`| ${p.pin} | ${p.function} | ${p.net} | ${p.purpose} | ${connected} |`);
    }
    lines.push("");
  }

  // Free GPIOs
  if (freeGpios.length > 0) {
    lines.push("## Unconnected Pins");
    lines.push("");
    lines.push(
      freeGpios.map((p) => `- **${p.function}** (pin ${p.pin})`).join("\n"),
    );
    lines.push("");
  }

  // Power rails
  if (powerRails.length > 0) {
    lines.push("## Power Rails");
    lines.push("");
    lines.push("| Rail | Source | Loads |");
    lines.push("|------|--------|-------|");
    for (const rail of powerRails) {
      const loads = rail.loads.length > 10
        ? `${rail.loads.slice(0, 10).join(", ")}... (${rail.loads.length} total)`
        : rail.loads.join(", ");
      lines.push(`| ${rail.net} | ${rail.source || "—"} | ${loads} |`);
    }
    lines.push("");
  }

  // Debug interfaces
  if (debugInterfaces.length > 0) {
    lines.push("## Debug Interfaces");
    lines.push("");
    for (const dbg of debugInterfaces) {
      lines.push(`### ${dbg.ref}: ${dbg.description}`);
      lines.push("");
      lines.push("| Pin | Net | Function |");
      lines.push("|-----|-----|----------|");
      for (const p of dbg.pins) {
        lines.push(`| ${p.pin} | ${p.net} | ${p.function} |`);
      }
      lines.push("");
    }
  }

  // Other connectors (non-debug)
  if (connectors.length > 0) {
    lines.push("## Connectors");
    lines.push("");
    for (const conn of connectors) {
      lines.push(`### ${conn.ref}: ${conn.description}`);
      lines.push("");
      lines.push("| Pin | Net | Function |");
      lines.push("|-----|-----|----------|");
      for (const p of conn.pins) {
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
