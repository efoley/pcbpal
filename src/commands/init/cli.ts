import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { isInteractive } from "../../cli/context.js";
import { fatal, output, runWithSpinner } from "../../cli/output.js";
import { type InitResult, initProject } from "./core.js";

function renderInitResult(result: InitResult): void {
  if (isInteractive()) {
    clack.intro(pc.bold("pcbpal init"));
    clack.log.success(`Initialized pcbpal in ${pc.cyan(result.root)}`);
    if (result.kicadProject) {
      clack.log.info(`KiCad project: ${pc.cyan(result.kicadProject)}`);
    }
    clack.log.info(
      `Files created:\n${result.filesCreated.map((f) => `  ${pc.green("+")} ${f}`).join("\n")}`,
    );
    clack.outro("Ready! Run pcbpal doctor to check your setup.");
  } else {
    console.log(`Initialized pcbpal in ${result.root}`);
    for (const f of result.filesCreated) {
      console.log(`  + ${f}`);
    }
  }
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize pcbpal in an existing KiCad project")
    .option("--kicad-project <path>", "Path to .kicad_pro file")
    .option("--no-git", "Don't create .gitignore for .pcbpal/")
    .action(async (opts) => {
      try {
        const result = await runWithSpinner(
          () =>
            initProject({
              dir: process.cwd(),
              kicadProject: opts.kicadProject,
              noGit: opts.noGit,
            }),
          "Initializing project...",
        );
        output(result, renderInitResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });
}
