import * as clack from "@clack/prompts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import { isInteractive } from "../../cli/context.js";
import { fatal, output, runWithSpinner } from "../../cli/output.js";
import { findProjectRoot } from "../../services/project.js";
import { type FirmwareDatasheetResult, firmwareDatasheet } from "./core.js";

function renderFirmwareResult(result: FirmwareDatasheetResult): void {
  if (isInteractive()) {
    clack.log.success(
      `Firmware reference for ${pc.bold(result.mcu.value)} (${result.mcu.ref})`,
    );
    const signalCount = result.pins.filter((p) => !p.isUnconnected).length;
    clack.log.info(
      `${signalCount} signal pins, ${result.freeGpios.length} unconnected`,
    );
    if (result.powerRails.length > 0) {
      clack.log.info(`${result.powerRails.length} power rails`);
    }
    if (result.debugInterfaces.length > 0) {
      clack.log.info(
        `Debug: ${result.debugInterfaces.map((d) => d.ref).join(", ")}`,
      );
    }
  } else {
    console.log(result.markdown);
  }
}

export function registerFirmwareCommand(program: Command): void {
  program
    .command("firmware-datasheet")
    .description("Generate a firmware-oriented board reference from the schematic netlist")
    .option("--mcu <ref>", "MCU reference designator (auto-detected if omitted)")
    .option("--include-tps", "Include test point net mappings")
    .option("--from-jlcpcb", "Read BOM from jlcpcb/project.db")
    .option("-o, --output <file>", "Output file (default: firmware_CLAUDE.md)")
    .action(
      async (opts: {
        mcu?: string;
        includeTps?: boolean;
        fromJlcpcb?: boolean;
        output?: string;
      }) => {
        try {
          const result = await runWithSpinner(
            () =>
              firmwareDatasheet({
                mcu: opts.mcu,
                includeTestPoints: opts.includeTps,
                fromJlcpcb: opts.fromJlcpcb,
              }),
            "Generating firmware datasheet...",
          );

          // Write markdown file
          const root = await findProjectRoot();
          const outPath = opts.output ?? join(root!, "firmware_CLAUDE.md");
          await writeFile(outPath, result.markdown, "utf-8");

          output(result, renderFirmwareResult);

          if (isInteractive()) {
            clack.log.info(`Written to ${pc.cyan(outPath)}`);
          }
        } catch (e) {
          fatal((e as Error).message);
        }
      },
    );
}
