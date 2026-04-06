import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Find .kicad_pro files in a directory.
 */
export async function findKicadProjects(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((e) => e.endsWith(".kicad_pro"));
}

/**
 * A component placement extracted from a KiCad schematic.
 */
export interface KicadComponent {
  ref: string;           // e.g. "R5", "U3", "C10"
  footprint: string;     // e.g. "Resistor_SMD:R_0603_1608Metric"
  value: string;         // e.g. "10k", "100nF"
  libId: string;         // e.g. "Device:C", "Amplifier_Operational:LM324"
  description: string;   // e.g. "Unpolarized capacitor"
  datasheet: string;     // URL or "~"
}

/**
 * Extract component reference, footprint, and value from a single .kicad_sch file.
 * Parses the S-expression text with regex — not a full parser but reliable
 * for the well-structured output KiCad produces.
 */
function extractComponentsFromSch(content: string): KicadComponent[] {
  const results: KicadComponent[] = [];

  // Match top-level (symbol ...) blocks — placed instances end at \n\t)
  const symbolRegex = /\(symbol\s[\s\S]*?\n\t\)/g;
  let match: RegExpExecArray | null;

  while ((match = symbolRegex.exec(content)) !== null) {
    const block = match[0];

    const refs = [...block.matchAll(/\(property\s+"Reference"\s+"([^"]+)"/g)];
    const fps = [...block.matchAll(/\(property\s+"Footprint"\s+"([^"]*)"/g)];
    const vals = [...block.matchAll(/\(property\s+"Value"\s+"([^"]*)"/g)];
    const descs = [...block.matchAll(/\(property\s+"Description"\s+"([^"]*)"/g)];
    const dss = [...block.matchAll(/\(property\s+"Datasheet"\s+"([^"]*)"/g)];
    const libIds = [...block.matchAll(/\(lib_id\s+"([^"]+)"/g)];

    // Instance overrides come after library defs, so take the last occurrence
    const ref = refs.length > 0 ? refs[refs.length - 1][1] : null;
    const fp = fps.length > 0 ? fps[fps.length - 1][1] : null;
    const val = vals.length > 0 ? vals[vals.length - 1][1] : null;
    const desc = descs.length > 0 ? descs[descs.length - 1][1] : "";
    const ds = dss.length > 0 ? dss[dss.length - 1][1] : "";
    const libId = libIds.length > 0 ? libIds[0][1] : "";

    // Only include actual placed components (ref has a number, skip power symbols)
    if (ref && /\d/.test(ref) && !ref.startsWith("#") && fp) {
      results.push({ ref, footprint: fp, value: val ?? "", libId, description: desc, datasheet: ds });
    }
  }

  return results;
}

/**
 * Read all .kicad_sch files in a project directory and extract
 * a map of reference designator → footprint + value.
 * Handles hierarchical schematics by reading all .kicad_sch files.
 */
export async function readSchematicComponents(
  projectDir: string,
): Promise<KicadComponent[]> {
  const entries = await readdir(projectDir);
  const schFiles = entries.filter((e) => e.endsWith(".kicad_sch"));

  const allComponents: KicadComponent[] = [];
  for (const file of schFiles) {
    const content = await readFile(join(projectDir, file), "utf-8");
    allComponents.push(...extractComponentsFromSch(content));
  }

  // Deduplicate by ref (same ref may appear in library def and instance)
  const byRef = new Map<string, KicadComponent>();
  for (const comp of allComponents) {
    // Later entries (instances) override earlier ones (library defs)
    byRef.set(comp.ref, comp);
  }

  return [...byRef.values()];
}

/**
 * Set the footprint property on component instances in the schematic files.
 * Finds each ref in the .kicad_sch files and rewrites its Footprint property.
 * Returns the refs that were actually modified.
 */
export async function assignFootprints(
  projectDir: string,
  refs: string[],
  footprint: string,
): Promise<{ modified: string[]; notFound: string[] }> {
  const entries = await readdir(projectDir);
  const schFiles = entries.filter((e) => e.endsWith(".kicad_sch"));

  const refsToFind = new Set(refs);
  const modified: string[] = [];

  for (const file of schFiles) {
    const filePath = join(projectDir, file);
    let content = await readFile(filePath, "utf-8");

    // Find placed symbol instances and check their reference
    const symbolRegex = /\(symbol\s[\s\S]*?\n\t\)/g;
    let match: RegExpExecArray | null;

    // Collect replacements (work backwards to preserve offsets)
    const replacements: { start: number; end: number; newBlock: string }[] = [];

    while ((match = symbolRegex.exec(content)) !== null) {
      const block = match[0];
      const blockStart = match.index;

      // Get the instance reference (last occurrence, which is the override)
      const refMatches = [...block.matchAll(/\(property\s+"Reference"\s+"([^"]+)"/g)];
      const ref = refMatches.length > 0 ? refMatches[refMatches.length - 1][1] : null;
      if (!ref || !refsToFind.has(ref)) continue;

      // Find and replace the Footprint property value in this block
      const fpRegex = /(\(property\s+"Footprint"\s+)"([^"]*)"/g;
      const fpMatches = [...block.matchAll(fpRegex)];
      if (fpMatches.length === 0) continue;

      // Replace the last Footprint match (instance override)
      const lastFp = fpMatches[fpMatches.length - 1];
      const fpStart = blockStart + lastFp.index!;
      const fpEnd = fpStart + lastFp[0].length;
      const newFp = `${lastFp[1]}"${footprint}"`;

      replacements.push({ start: fpStart, end: fpEnd, newBlock: newFp });
      modified.push(ref);
      refsToFind.delete(ref);
    }

    // Apply replacements in reverse order to preserve offsets
    if (replacements.length > 0) {
      for (const r of replacements.reverse()) {
        content = content.slice(0, r.start) + r.newBlock + content.slice(r.end);
      }
      await writeFile(filePath, content, "utf-8");
    }
  }

  return { modified, notFound: [...refsToFind] };
}

/**
 * Check if kicad-cli is available and return its version.
 */
export async function getKicadCliVersion(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["kicad-cli", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      return text.trim();
    }
    return null;
  } catch {
    return null;
  }
}
