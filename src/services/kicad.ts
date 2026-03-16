import { readdir } from "node:fs/promises";

/**
 * Find .kicad_pro files in a directory.
 */
export async function findKicadProjects(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((e) => e.endsWith(".kicad_pro"));
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
