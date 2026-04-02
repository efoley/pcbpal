import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { isInteractive } from "../../cli/context.js";
import { fatal, output, runWithSpinner } from "../../cli/output.js";
import { type LibFetchResult, type LibInstallResult, libFetch, libInstall } from "./core.js";

function renderFetchResult(result: LibFetchResult): void {
  if (isInteractive()) {
    clack.log.success(`Fetched ${pc.bold(result.lcsc)}`);
    if (result.symbolPath) clack.log.info(`Symbol:    ${pc.cyan(result.symbolPath)}`);
    if (result.footprintDir) clack.log.info(`Footprint: ${pc.cyan(result.footprintDir)}`);
    if (result.modelPath) clack.log.info(`3D model:  ${pc.cyan(result.modelPath)}`);
  } else {
    console.log(`Fetched ${result.lcsc}`);
    if (result.symbolPath) console.log(`Symbol: ${result.symbolPath}`);
    if (result.footprintDir) console.log(`Footprint: ${result.footprintDir}`);
    if (result.modelPath) console.log(`3D model: ${result.modelPath}`);
  }
}

export function registerLibCommand(program: Command): void {
  const lib = program.command("lib").description("Manage local symbol/footprint libraries");

  lib
    .command("fetch <lcsc>")
    .description("Download symbol + footprint from LCSC/EasyEDA")
    .option("--symbol", "Fetch symbol only")
    .option("--footprint", "Fetch footprint only")
    .option("--3d", "Fetch 3D model only")
    .action(async (lcsc: string, flags: { symbol?: boolean; footprint?: boolean; "3d"?: boolean }) => {
      try {
        const result = await runWithSpinner(
          () => libFetch({ lcsc, symbol: flags.symbol, footprint: flags.footprint, model3d: flags["3d"] }),
          `Fetching ${lcsc}...`,
        );
        output(result, renderFetchResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });

  lib
    .command("install")
    .description("Add fetched libraries to KiCad's sym-lib-table and fp-lib-table")
    .action(async () => {
      try {
        const result = await runWithSpinner(() => libInstall(), "Installing libraries...");
        output(result, renderInstallResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });
}

function renderInstallResult(result: LibInstallResult): void {
  if (isInteractive()) {
    const symTotal = result.symbolsAdded.length + result.symbolsExisting;
    const fpTotal = result.footprintsAdded.length + result.footprintsExisting;

    if (result.symbolsAdded.length > 0) {
      clack.log.success(`Added ${result.symbolsAdded.length} symbol libraries`);
    }
    if (result.footprintsAdded.length > 0) {
      clack.log.success(`Added ${result.footprintsAdded.length} footprint libraries`);
    }
    if (result.symbolsAdded.length === 0 && result.footprintsAdded.length === 0) {
      clack.log.info(`All ${symTotal} symbol and ${fpTotal} footprint libraries already installed`);
    } else {
      if (result.symbolsExisting > 0 || result.footprintsExisting > 0) {
        clack.log.info(
          `${result.symbolsExisting} symbol and ${result.footprintsExisting} footprint libraries already present`,
        );
      }
    }
  } else {
    for (const name of result.symbolsAdded) console.log(`+ sym ${name}`);
    for (const name of result.footprintsAdded) console.log(`+ fp  ${name}`);
    console.log(
      `${result.symbolsAdded.length} symbols added, ${result.footprintsAdded.length} footprints added`,
    );
  }
}
