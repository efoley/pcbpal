import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { isInteractive } from "../../cli/context.js";
import { fatal, output, runWithSpinner } from "../../cli/output.js";
import { type LibFetchResult, libFetch } from "./core.js";

function renderFetchResult(result: LibFetchResult): void {
  if (isInteractive()) {
    clack.log.success(`Fetched ${pc.bold(result.lcsc)} — ${result.mpn}`);
    clack.log.info(result.description);
    if (result.symbolPath) clack.log.info(`Symbol: ${pc.cyan(result.symbolPath)}`);
    if (result.footprintPath) clack.log.info(`Footprint: ${pc.cyan(result.footprintPath)}`);
    if (!result.symbolPath && !result.footprintPath) {
      clack.log.warn("No symbol or footprint data available for this part");
    }
  } else {
    console.log(`Fetched ${result.lcsc} — ${result.mpn}`);
    console.log(result.description);
    if (result.symbolPath) console.log(`Symbol: ${result.symbolPath}`);
    if (result.footprintPath) console.log(`Footprint: ${result.footprintPath}`);
  }
}

export function registerLibCommand(program: Command): void {
  const lib = program.command("lib").description("Manage local symbol/footprint libraries");

  lib
    .command("fetch <lcsc>")
    .description("Download symbol + footprint from LCSC/EasyEDA")
    .action(async (lcsc: string) => {
      try {
        const result = await runWithSpinner(() => libFetch({ lcsc }), `Fetching ${lcsc}...`);
        output(result, renderFetchResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });
}
