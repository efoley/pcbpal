import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Types ──

export interface NetlistSheet {
  number: number;
  name: string;
  source: string;
}

export interface NetlistComponent {
  ref: string;
  value: string;
  footprint: string;
  description: string;
  libPart: string; // e.g. "Device:C"
  sheetName: string; // e.g. "/Power/"
  sheetFile: string;
}

export interface NetlistNode {
  ref: string;
  pin: string;
  pinFunction: string; // e.g. "PA5", "K", ""
  pinType: string; // e.g. "bidirectional", "passive", "power_in"
}

export interface NetlistNet {
  code: number;
  name: string;
  nodes: NetlistNode[];
}

export interface Netlist {
  sheets: NetlistSheet[];
  components: NetlistComponent[];
  nets: NetlistNet[];
}

// ── Simple XML tag parser (avoids npm dependency) ──

function extractTag(xml: string, tag: string, start = 0): { content: string; end: number } | null {
  const openTag = `<${tag}`;
  const idx = xml.indexOf(openTag, start);
  if (idx === -1) return null;

  // Find the end of the opening tag
  const tagEnd = xml.indexOf(">", idx);
  if (tagEnd === -1) return null;

  // Self-closing tag
  if (xml[tagEnd - 1] === "/") {
    return { content: "", end: tagEnd + 1 };
  }

  const closeTag = `</${tag}>`;
  const closeIdx = xml.indexOf(closeTag, tagEnd);
  if (closeIdx === -1) return null;

  return { content: xml.slice(tagEnd + 1, closeIdx), end: closeIdx + closeTag.length };
}

function extractAttr(tagStr: string, attr: string): string {
  const regex = new RegExp(`${attr}="([^"]*)"`, "i");
  const match = tagStr.match(regex);
  return match?.[1] ?? "";
}

function extractTagValue(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match?.[1]?.trim() ?? "";
}

// ── Parse KiCad XML netlist ──

export function parseNetlistXml(xml: string): Netlist {
  const sheets: NetlistSheet[] = [];
  const components: NetlistComponent[] = [];
  const nets: NetlistNet[] = [];

  // Parse sheets
  const sheetRegex = /<sheet\s+number="(\d+)"\s+name="([^"]*)"[^>]*>/g;
  let sheetMatch: RegExpExecArray | null;
  while ((sheetMatch = sheetRegex.exec(xml)) !== null) {
    const sheetBlock = xml.slice(sheetMatch.index, xml.indexOf("</sheet>", sheetMatch.index) + 8);
    sheets.push({
      number: parseInt(sheetMatch[1]),
      name: sheetMatch[2],
      source: extractTagValue(sheetBlock, "source"),
    });
  }

  // Parse components
  const compRegex = /<comp\s+ref="([^"]+)">/g;
  let compMatch: RegExpExecArray | null;
  while ((compMatch = compRegex.exec(xml)) !== null) {
    const compEnd = xml.indexOf("</comp>", compMatch.index);
    const block = xml.slice(compMatch.index, compEnd);

    const sheetpathMatch = block.match(/<sheetpath\s+names="([^"]*)"/);
    const sheetfileMatch = block.match(/<property\s+name="Sheetfile"\s+value="([^"]*)"/);
    const libMatch = block.match(/<libsource\s+lib="([^"]*)"\s+part="([^"]*)"/);

    components.push({
      ref: compMatch[1],
      value: extractTagValue(block, "value"),
      footprint: extractTagValue(block, "footprint"),
      description: extractTagValue(block, "description"),
      libPart: libMatch ? `${libMatch[1]}:${libMatch[2]}` : "",
      sheetName: sheetpathMatch?.[1] ?? "/",
      sheetFile: sheetfileMatch?.[1] ?? "",
    });
  }

  // Parse nets
  const netRegex = /<net\s+code="(\d+)"\s+name="([^"]*)"[^>]*>/g;
  let netMatch: RegExpExecArray | null;
  while ((netMatch = netRegex.exec(xml)) !== null) {
    const netEnd = xml.indexOf("</net>", netMatch.index);
    const block = xml.slice(netMatch.index, netEnd);

    const nodes: NetlistNode[] = [];
    const nodeRegex = /<node\s+([^>]+)\/>/g;
    let nodeMatch: RegExpExecArray | null;
    while ((nodeMatch = nodeRegex.exec(block)) !== null) {
      const attrs = nodeMatch[1];
      nodes.push({
        ref: extractAttr(attrs, "ref"),
        pin: extractAttr(attrs, "pin"),
        pinFunction: extractAttr(attrs, "pinfunction"),
        pinType: extractAttr(attrs, "pintype"),
      });
    }

    nets.push({
      code: parseInt(netMatch[1]),
      name: netMatch[2],
      nodes,
    });
  }

  return { sheets, components, nets };
}

/**
 * Export and parse the netlist from a KiCad schematic.
 */
export async function exportNetlist(schPath: string): Promise<Netlist> {
  const tmpFile = join(tmpdir(), `pcbpal-netlist-${Date.now()}.xml`);

  const proc = Bun.spawn(
    ["kicad-cli", "sch", "export", "netlist", schPath, "--format", "kicadxml", "-o", tmpFile],
    { stdout: "pipe", stderr: "pipe" },
  );
  await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Netlist export failed: ${stderr.trim()}`);
  }

  const xml = await readFile(tmpFile, "utf-8");
  const { unlink } = await import("node:fs/promises");
  await unlink(tmpFile).catch(() => {});

  return parseNetlistXml(xml);
}
