import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { isInteractive } from "../../cli/context.js";
import { fatal, output, runWithSpinner } from "../../cli/output.js";
import { type ExportResult, productionExport } from "./core.js";

function renderExportResult(result: ExportResult): void {
  if (isInteractive()) {
    clack.log.success("Production files generated");
    clack.log.info(`Gerbers: ${pc.cyan(result.gerberDir)} (${result.gerberFiles} files)`);
    clack.log.info(`BOM:     ${pc.cyan(result.bomCsvPath)} (${result.bomEntries} unique parts)`);
    clack.log.info(`CPL:     ${pc.cyan(result.cplCsvPath)} (${result.cplEntries} placements)`);
    clack.log.info(`ZIP:     ${pc.cyan(result.zipPath)}`);
    if (result.correctionsApplied > 0) {
      clack.log.info(
        `Rotation corrections applied to ${result.correctionsApplied} components`,
      );
    }
  } else {
    console.log(`Gerbers: ${result.gerberDir} (${result.gerberFiles} files)`);
    console.log(`BOM: ${result.bomCsvPath} (${result.bomEntries} parts)`);
    console.log(`CPL: ${result.cplCsvPath} (${result.cplEntries} placements)`);
    console.log(`ZIP: ${result.zipPath}`);
    if (result.correctionsApplied > 0) {
      console.log(`Corrections applied: ${result.correctionsApplied}`);
    }
  }
}

export function registerProductionCommand(program: Command): void {
  const prod = program
    .command("production")
    .description("Configure and export production files");

  prod
    .command("export")
    .description("Generate JLCPCB BOM + CPL CSV files")
    .option("--output <dir>", "Output directory")
    .option("--from-jlcpcb", "Read BOM from jlcpcb/project.db")
    .option("--use-drill-origin", "Use drill/place file origin for positions")
    .action(
      async (opts: {
        output?: string;
        fromJlcpcb?: boolean;
        useDrillOrigin?: boolean;
      }) => {
        try {
          const result = await runWithSpinner(
            () =>
              productionExport({
                outputDir: opts.output,
                fromJlcpcb: opts.fromJlcpcb,
                useDrillOrigin: opts.useDrillOrigin,
              }),
            "Generating production files...",
          );
          output(result, renderExportResult);
        } catch (e) {
          fatal((e as Error).message);
        }
      },
    );
}
