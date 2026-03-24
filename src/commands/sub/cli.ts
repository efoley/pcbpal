import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { isInteractive } from "../../cli/context.js";
import { fatal, output, runWithSpinner } from "../../cli/output.js";
import type {
  SubBuildResult,
  SubExportResult,
  SubListResult,
  SubNewResult,
  SubPreviewResult,
} from "./core.js";
import { subBuild, subExport, subList, subNew, subPreview } from "./core.js";

function renderNewResult(result: SubNewResult): void {
  if (isInteractive()) {
    clack.log.success(`Created subcircuit: ${pc.cyan(`subcircuits/${result.name}.tsx`)}`);
    clack.log.info("Edit the file, then run:");
    clack.log.step(`  pcbpal sub build ${result.name}`);
    clack.log.step(`  pcbpal sub preview ${result.name}`);
  } else {
    console.log(`Created subcircuits/${result.name}.tsx`);
  }
}

function renderListResult(result: SubListResult): void {
  if (result.total === 0) {
    console.log("No subcircuits found. Create one with: pcbpal sub new <name>");
    return;
  }

  for (const sub of result.subcircuits) {
    const status = sub.hasCircuitJson ? pc.green("built") : pc.dim("not built");
    console.log(`  ${sub.name}  ${status}`);
  }
  console.log(`\n${result.total} subcircuit(s)`);
}

function renderBuildResult(result: SubBuildResult): void {
  for (const r of result.results) {
    if (r.ok) {
      const info = `${r.componentCount} components, ${r.netCount} nets`;
      if (isInteractive()) {
        clack.log.success(`${pc.cyan(r.name)} — ${info}`);
      } else {
        console.log(`OK ${r.name} — ${info}`);
      }
    } else {
      if (isInteractive()) {
        clack.log.error(`${pc.red(r.name)} — ${r.errors.length} error(s)`);
      } else {
        console.log(`FAIL ${r.name}`);
      }
      for (const err of r.errors) {
        console.log(`  ${pc.red("error:")} ${err.message}`);
      }
    }
    for (const warn of r.warnings) {
      console.log(`  ${pc.yellow("warn:")} ${warn.message}`);
    }
  }
}

function renderPreviewResult(result: SubPreviewResult): void {
  if (isInteractive()) {
    clack.log.success(`Preview written to ${pc.cyan(result.path)}`);
  } else {
    console.log(result.path);
  }
}

function renderExportResult(result: SubExportResult): void {
  if (isInteractive()) {
    clack.log.success(`Exported ${pc.cyan(result.name)} → ${pc.cyan(result.path)}`);
  } else {
    console.log(result.path);
  }
}

export function registerSubCommand(program: Command): void {
  const sub = program.command("sub").description("Manage tscircuit subcircuits");

  sub
    .command("new")
    .argument("<name>", "Subcircuit name (e.g. voltage-divider)")
    .description("Scaffold a new subcircuit TSX file")
    .action(async (name: string) => {
      try {
        const result = await subNew({ name });
        output(result, renderNewResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });

  sub
    .command("list")
    .description("List all subcircuits")
    .action(async () => {
      try {
        const result = await subList();
        output(result, renderListResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });

  sub
    .command("build")
    .argument("[name]", "Subcircuit name (omit with --all)")
    .option("--all", "Build all subcircuits")
    .description("Compile subcircuit TSX to Circuit JSON")
    .action(async (name: string | undefined, opts) => {
      try {
        const result = await runWithSpinner(
          () => subBuild({ name, all: opts.all }),
          "Building subcircuit...",
        );
        output(result, renderBuildResult);
        if (!result.ok) {
          process.exit(1);
        }
      } catch (e) {
        fatal((e as Error).message);
      }
    });

  sub
    .command("preview")
    .argument("<name>", "Subcircuit name")
    .option("--view <type>", "View type: schematic, pcb, assembly", "schematic")
    .option("--output <path>", "Output file path")
    .option("--open", "Open in default viewer")
    .description("Render subcircuit as SVG preview")
    .action(async (name: string, opts) => {
      try {
        const result = await runWithSpinner(
          () => subPreview({ name, view: opts.view, output: opts.output }),
          "Rendering preview...",
        );
        output(result, renderPreviewResult);

        if (opts.open) {
          const { exec } = await import("node:child_process");
          exec(`xdg-open "${result.path}" 2>/dev/null || open "${result.path}"`);
        }
      } catch (e) {
        fatal((e as Error).message);
      }
    });

  sub
    .command("export")
    .argument("<name>", "Subcircuit name")
    .option("--format <fmt>", "Output format: kicad_sch, kicad_pcb", "kicad_sch")
    .option("--output <path>", "Output file path")
    .description("Export subcircuit to KiCad format")
    .action(async (name: string, opts) => {
      try {
        const result = await runWithSpinner(
          () => subExport({ name, format: opts.format, output: opts.output }),
          "Exporting to KiCad...",
        );
        output(result, renderExportResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });
}
