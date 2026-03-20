import type { Command } from "commander";
import pc from "picocolors";
import { isInteractive } from "../../cli/context.js";
import { fatal, output, runWithSpinner } from "../../cli/output.js";
import { type SearchResult, searchParts } from "./core.js";

function renderSearchTable(result: SearchResult): void {
  if (result.results.length === 0) {
    console.log("No results found.");
    return;
  }

  const header = ["LCSC#", "Type", "MPN", "Description", "Package", "Stock", "Price", "URL"];
  const rows = result.results.map((r) => [
    r.lcsc,
    r.library_type === "basic" ? "B" : "E",
    r.mpn,
    r.description.length > 50 ? `${r.description.slice(0, 47)}...` : r.description,
    r.package,
    r.stock.toLocaleString(),
    r.unit_price_usd !== null ? `$${r.unit_price_usd.toFixed(4)}` : "—",
    r.url ?? "—",
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");

  if (isInteractive()) {
    console.log(pc.bold(line(header)));
    console.log(widths.map((w) => "─".repeat(w)).join("  "));
  } else {
    console.log(line(header));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
  }

  for (const row of rows) {
    console.log(line(row));
  }

  console.log(`\n${result.total} results for "${result.query}"`);
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .argument("[query]", "Search query")
    .description("Search for components across suppliers")
    .option("--supplier <name>", "Supplier to search (lcsc)")
    .option("--in-stock", "Only show in-stock parts")
    .option("--max-price <usd>", "Maximum unit price in USD", parseFloat)
    .option("--limit <n>", "Max results", parseInt)
    .option("--lcsc <part>", "Lookup by LCSC part number (e.g. C123456)")
    .action(async (query: string | undefined, opts) => {
      if (!query && !opts.lcsc) {
        fatal("Provide a search query or --lcsc part number");
      }

      try {
        const result = await runWithSpinner(
          () =>
            searchParts({
              query: query ?? opts.lcsc,
              supplier: opts.supplier,
              inStock: opts.inStock,
              maxPrice: opts.maxPrice,
              limit: opts.limit,
              lcsc: opts.lcsc,
            }),
          "Searching LCSC...",
        );
        output(result, renderSearchTable);
      } catch (e) {
        fatal((e as Error).message);
      }
    });
}
