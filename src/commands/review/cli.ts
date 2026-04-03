import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { isInteractive } from "../../cli/context.js";
import { fatal, output } from "../../cli/output.js";
import {
  type ReviewContext,
  type ReviewTarget,
  reviewPrepare,
} from "./core.js";

function renderReviewResult(result: ReviewContext): void {
  if (isInteractive()) {
    clack.log.success(`Review context prepared for ${pc.bold(result.target)}`);
    clack.log.info(`Output: ${pc.cyan(result.outputDir)}`);

    if (result.images.length > 0) {
      clack.log.info(`Images: ${result.images.length} SVG(s)`);
    }

    const ctx = result.context;
    if (ctx.schematicComponents) {
      clack.log.info(`Schematic: ${ctx.schematicComponents.length} components`);
    }
    if (ctx.bom) {
      clack.log.info(
        `BOM: ${ctx.bom.entries} entries (${ctx.bom.withLcsc} with LCSC, ${ctx.bom.withoutSource} without source)`,
      );
    }
    if (ctx.drc) {
      const drcColor = ctx.drc.violations > 0 ? pc.yellow : pc.green;
      clack.log.info(
        drcColor(`DRC: ${ctx.drc.violations} violations, ${ctx.drc.unconnected} unconnected`),
      );
    }

    clack.log.info(`Context JSON: ${pc.cyan(result.contextJsonPath)}`);
  } else {
    console.log(`target: ${result.target}`);
    console.log(`output: ${result.outputDir}`);
    for (const img of result.images) {
      console.log(`image: ${img}`);
    }
    console.log(`context: ${result.contextJsonPath}`);
  }
}

const VALID_TARGETS = new Set(["schematic", "pcb", "bom", "drc"]);

export function registerReviewCommand(program: Command): void {
  program
    .command("review <target>")
    .description("Prepare review context (schematic, pcb, bom, drc)")
    .option("--sheet <page>", "Specific schematic sheet/page number")
    .option("--context <files>", "Additional context files (comma-separated)")
    .option("--from-jlcpcb", "Read BOM from jlcpcb/project.db")
    .action(
      async (
        target: string,
        opts: { sheet?: string; context?: string; fromJlcpcb?: boolean },
      ) => {
        if (!VALID_TARGETS.has(target)) {
          fatal(
            `Invalid target "${target}". Valid targets: ${[...VALID_TARGETS].join(", ")}`,
          );
        }

        try {
          let spinner: ReturnType<typeof clack.spinner> | null = null;
          if (isInteractive()) {
            spinner = clack.spinner();
            spinner.start(`Preparing ${target} review context...`);
          }

          const result = await reviewPrepare(
            {
              target: target as ReviewTarget,
              sheet: opts.sheet,
              contextFiles: opts.context?.split(",").map((f) => f.trim()),
              fromJlcpcb: opts.fromJlcpcb,
            },
            spinner ? (msg) => spinner!.message(msg) : undefined,
          );

          if (spinner) spinner.stop("Done");
          output(result, renderReviewResult);
        } catch (e) {
          fatal((e as Error).message);
        }
      },
    );
}
