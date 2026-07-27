import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { isInteractive, isJson } from "../../cli/context.js";
import { fatal, output, runWithSpinner } from "../../cli/output.js";
import type { Finding } from "../../services/refcircuit.js";
import { type DiffResult, diffCircuit } from "./diff.js";
import { type ExtractFacet, type ExtractPrepareResult, extractPrepare } from "./extract.js";
import { type FetchResult, fetchDatasheetCommand } from "./fetch.js";
import { type PagesResult, pagesCommand } from "./pages.js";
import { type ValidateResult, validateExtraction } from "./validate.js";

function renderFetchResult(result: FetchResult): void {
  if (isInteractive()) {
    clack.log.success(result.cached ? "Datasheet already cached" : "Datasheet downloaded");
    clack.log.info(`Path: ${pc.cyan(result.path)}`);
    clack.log.info(`SHA-256: ${result.sha256.slice(0, 16)}…`);
  } else {
    console.log(`path: ${result.path}`);
    console.log(`sha256: ${result.sha256}`);
    console.log(`cached: ${result.cached}`);
  }
}

function renderPagesResult(result: PagesResult): void {
  if ("index" in result) {
    if (isInteractive()) {
      clack.log.info(`${pc.bold(result.pdf)} — ${result.pages} pages`);
      for (const entry of result.index) {
        const items = [...entry.figures, ...entry.tables];
        if (items.length > 0) {
          clack.log.info(`p.${entry.page}: ${items.join(" | ")}`);
        }
      }
    } else {
      console.log(`pdf: ${result.pdf}`);
      console.log(`pages: ${result.pages}`);
      for (const entry of result.index) {
        for (const f of entry.figures) console.log(`p${entry.page} figure: ${f}`);
        for (const t of entry.tables) console.log(`p${entry.page} table: ${t}`);
      }
    }
  } else {
    if (isInteractive()) {
      clack.log.success(`Rendered ${result.images.length} page(s)`);
      clack.log.info(`Output: ${pc.cyan(result.outDir)}`);
    } else {
      for (const img of result.images) console.log(`image: ${img}`);
    }
  }
}

function renderFinding(f: Finding): string {
  const where = f.where ? ` (${f.where})` : "";
  return `[${f.code}] ${f.message}${where}`;
}

function renderValidateResult(result: ValidateResult): void {
  if (isInteractive()) {
    const header = `${result.facet} extraction for ${pc.bold(result.device)}`;
    if (result.ok) {
      clack.log.success(`Valid: ${header}`);
    } else {
      clack.log.error(`Invalid: ${header}`);
    }
    for (const e of result.errors) clack.log.error(pc.red(renderFinding(e)));
    for (const w of result.warnings) clack.log.warn(pc.yellow(renderFinding(w)));
    const stats = Object.entries(result.stats)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    if (stats) clack.log.info(stats);
  } else {
    console.log(`ok: ${result.ok}`);
    console.log(`facet: ${result.facet}`);
    console.log(`device: ${result.device}`);
    for (const e of result.errors) console.log(`error: ${renderFinding(e)}`);
    for (const w of result.warnings) console.log(`warning: ${renderFinding(w)}`);
  }
}

function renderExtractResult(result: ExtractPrepareResult): void {
  if (isInteractive()) {
    clack.log.success(
      `Task package prepared for ${pc.bold(result.manifest.device)} (${result.manifest.facet})`,
    );
    clack.log.info(`Task dir: ${pc.cyan(result.taskDir)}`);
    clack.log.info(
      `Pages: ${result.manifest.pages.join(", ")}${result.autoDetectedPages ? " (auto-detected)" : ""}`,
    );
    clack.log.info(`Write extraction to: ${pc.cyan(result.manifest.output_file)}`);
    clack.log.info(`Then run: ${result.manifest.validate_command}`);
  } else {
    console.log(`taskDir: ${result.taskDir}`);
    console.log(`pages: ${result.manifest.pages.join(",")}`);
    console.log(`output: ${result.manifest.output_file}`);
    console.log(`validate: ${result.manifest.validate_command}`);
  }
}

function renderDiffResult(result: DiffResult): void {
  const m = result.comparison.metrics;
  if (isInteractive()) {
    if (result.ok) {
      clack.log.success(`Schematic matches the ${pc.bold(result.device)} reference circuit`);
    } else {
      clack.log.error(`Schematic differs from the ${pc.bold(result.device)} reference circuit`);
    }
    clack.log.info(`Compared refs: ${result.comparedRefs.join(", ")}`);
    clack.log.info(
      `connection F1 ${m.connectionF1.toFixed(2)}, net exactness ${m.netExactness.toFixed(2)}, value accuracy ${m.valueAccuracy.toFixed(2)}`,
    );
    for (const hint of result.hints) clack.log.warn(pc.yellow(hint));
  } else {
    console.log(`ok: ${result.ok}`);
    console.log(`device: ${result.device}`);
    console.log(`refs: ${result.comparedRefs.join(",")}`);
    console.log(
      `metrics: connectionF1=${m.connectionF1.toFixed(3)} netExactness=${m.netExactness.toFixed(3)} valueAccuracy=${m.valueAccuracy.toFixed(3)} topologyPass=${m.topologyPass}`,
    );
    for (const hint of result.hints) console.log(`hint: ${hint}`);
  }
}

const VALID_FACETS = new Set(["specs", "pins", "circuit"]);

export function registerDatasheetCommand(program: Command): void {
  const datasheet = program
    .command("datasheet")
    .description("Fetch, index, and validate datasheet extractions");

  datasheet
    .command("fetch")
    .description("Download a datasheet PDF into the project cache")
    .option("--url <url>", "Direct datasheet URL")
    .option("--lcsc <part>", "LCSC part number (e.g. C123456)")
    .option("--bom-id <id>", "BOM entry id, ref, or MPN")
    .action(async (opts: { url?: string; lcsc?: string; bomId?: string }) => {
      if (!opts.url && !opts.lcsc && !opts.bomId) {
        fatal("Provide one of --url, --lcsc, or --bom-id");
      }
      try {
        const result = await runWithSpinner(
          () => fetchDatasheetCommand(opts),
          "Fetching datasheet...",
        );
        output(result, renderFetchResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });

  datasheet
    .command("pages <source>")
    .description("Render datasheet pages to PNG, or list the page index")
    .option("--pages <spec>", 'Pages to render, e.g. "3,7-9" or "all"')
    .option("--dpi <n>", "Render resolution (default 200)")
    .option("--list", "List page index (figures/tables) instead of rendering")
    .action(async (source: string, opts: { pages?: string; dpi?: string; list?: boolean }) => {
      try {
        const result = await runWithSpinner(
          () =>
            pagesCommand({
              source,
              pages: opts.pages,
              dpi: opts.dpi ? Number.parseInt(opts.dpi, 10) : undefined,
              list: opts.list,
            }),
          opts.list ? "Indexing pages..." : "Rendering pages...",
        );
        output(result, renderPagesResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });

  datasheet
    .command("extract <source>")
    .description("Prepare an extraction task package for an LLM sub-agent")
    .requiredOption("--facet <facet>", "specs, pins, or circuit")
    .option("--pages <spec>", 'Pages to include, e.g. "3,7-9" (default: auto-detect)')
    .option("--dpi <n>", "Render resolution (default 200)")
    .option("--device <name>", "Device name for the extraction")
    .option("--prepare", "Prepare a task package (currently the only mode)", true)
    .action(
      async (
        source: string,
        opts: { facet: string; pages?: string; dpi?: string; device?: string },
      ) => {
        if (!VALID_FACETS.has(opts.facet)) {
          fatal(`Invalid facet "${opts.facet}". Valid facets: specs, pins, circuit`);
        }
        try {
          const result = await runWithSpinner(
            () =>
              extractPrepare({
                source,
                facet: opts.facet as ExtractFacet,
                pages: opts.pages,
                dpi: opts.dpi ? Number.parseInt(opts.dpi, 10) : undefined,
                device: opts.device,
              }),
            "Preparing extraction task package...",
          );
          output(result, renderExtractResult);
        } catch (e) {
          fatal((e as Error).message);
        }
      },
    );

  datasheet
    .command("diff <file>")
    .description("Compare an extracted reference circuit against the KiCad schematic")
    .option("--refs <refs>", "Comma-separated KiCad refs to compare (default: auto-scope)")
    .action(async (file: string, opts: { refs?: string }) => {
      let result: DiffResult;
      try {
        result = await runWithSpinner(
          () =>
            diffCircuit({
              file,
              refs: opts.refs?.split(",").map((r) => r.trim()),
            }),
          "Comparing against schematic...",
        );
      } catch (e) {
        fatal((e as Error).message);
      }
      if (isJson()) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        renderDiffResult(result);
      }
      if (!result.ok) process.exit(2);
    });

  datasheet
    .command("validate <file>")
    .description("Validate an extraction JSON (schema + deterministic checks)")
    .option("--against-lcsc <part>", "Cross-check against LCSC part attributes")
    .action(async (file: string, opts: { againstLcsc?: string }) => {
      let result: ValidateResult;
      try {
        result = await validateExtraction({ file, againstLcsc: opts.againstLcsc });
      } catch (e) {
        fatal((e as Error).message);
      }
      if (isJson()) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        renderValidateResult(result);
      }
      if (!result.ok) process.exit(2);
    });
}
