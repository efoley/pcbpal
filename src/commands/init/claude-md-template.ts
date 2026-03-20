import { readFileSync } from "node:fs";
import { join } from "node:path";

const template = readFileSync(join(import.meta.dirname, "claude-md-template.md"), "utf-8");

export function generateClaudeMd(projectName: string, kicadProject: string | null): string {
  const kicadLine = kicadProject
    ? `\nThe KiCad project file is \`${kicadProject}\`. Open it in KiCad to edit schematics and layout.\n`
    : "";

  return template
    .replace("{{PROJECT_NAME}}", projectName)
    .replace("{{KICAD_LINE}}", kicadLine);
}
