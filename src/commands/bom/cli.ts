import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { isInteractive } from "../../cli/context.js";
import { fatal, output } from "../../cli/output.js";
import {
  type BomAddResult,
  type BomLinkResult,
  type BomRemoveResult,
  type BomShowResult,
  bomAdd,
  bomLink,
  bomRemove,
  bomShow,
} from "./core.js";
import { type BomCheckResult, type BomIssue, bomCheck } from "./check.js";

function renderBomTable(result: BomShowResult): void {
  if (result.entries.length === 0) {
    if (isInteractive()) {
      clack.log.info("BOM is empty. Add parts with `pcbpal bom add`.");
    } else {
      console.log("(empty)");
    }
    return;
  }

  // Simple padded table
  const header = ["ID (short)", "Role", "MPN", "Category", "Refs", "Status"];
  const rows = result.entries.map((e) => [
    e.id.slice(0, 8),
    e.role,
    e.mpn ?? "—",
    e.category,
    e.kicad_refs.join(", ") || "—",
    e.status,
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

  console.log(`\n${result.total} entries`);
}

function renderAddResult(result: BomAddResult): void {
  const e = result.entry;
  if (isInteractive()) {
    clack.log.success(`Added: ${pc.bold(e.role)} (${e.id.slice(0, 8)})`);
    if (e.mpn) clack.log.info(`MPN: ${e.mpn}`);
    if (e.sources.length > 0) {
      clack.log.info(`Source: ${e.sources[0].supplier} ${e.sources[0].part_number}`);
    }
  } else {
    console.log(`Added ${e.role} (${e.id.slice(0, 8)})`);
  }
}

function renderRemoveResult(result: BomRemoveResult): void {
  if (isInteractive()) {
    clack.log.success(
      `Removed: ${pc.bold(result.removed.role)} (${result.removed.id.slice(0, 8)})`,
    );
  } else {
    console.log(`Removed ${result.removed.role} (${result.removed.id.slice(0, 8)})`);
  }
}

function renderLinkResult(result: BomLinkResult): void {
  const e = result.entry;
  if (isInteractive()) {
    clack.log.success(`Linked ${pc.bold(e.role)} to refs: ${pc.cyan(e.kicad_refs.join(", "))}`);
  } else {
    console.log(`Linked ${e.role} to refs: ${e.kicad_refs.join(", ")}`);
  }
}

const SEVERITY_ICON: Record<string, string> = {
  error: "x",
  warning: "!",
  info: "-",
};

function renderCheckResult(result: BomCheckResult): void {
  if (isInteractive()) {
    if (result.total_entries === 0) {
      clack.log.info("BOM is empty — nothing to check.");
      return;
    }

    const summary = result.ok
      ? pc.green("All checks passed")
      : pc.red(`${result.errors} error(s), ${result.warnings} warning(s)`);
    clack.log.info(`Checked ${result.total_entries} BOM entries. ${summary}`);

    if (result.entries_checked > 0) {
      clack.log.info(`Verified ${result.entries_checked} parts against LCSC API`);
    }

    for (const i of result.issues) {
      const refStr = i.refs.length > 0 ? ` [${i.refs.join(", ")}]` : "";
      const prefix = i.severity === "error" ? pc.red("ERR") : i.severity === "warning" ? pc.yellow("WARN") : pc.dim("INFO");
      console.log(`  ${prefix} ${pc.bold(i.entry_role)}${pc.dim(refStr)}: ${i.message}`);
    }
  } else {
    if (result.total_entries === 0) {
      console.log("BOM is empty");
      return;
    }
    for (const i of result.issues) {
      const refStr = i.refs.length > 0 ? ` [${i.refs.join(", ")}]` : "";
      console.log(`${SEVERITY_ICON[i.severity]} ${i.entry_role}${refStr}: ${i.message}`);
    }
    console.log(
      `\n${result.total_entries} entries, ${result.errors} errors, ${result.warnings} warnings`,
    );
  }
}

export function registerBomCommand(program: Command): void {
  const bom = program.command("bom").description("Manage the bill of materials");

  bom
    .command("show")
    .description("Display current BOM")
    .option("--status <status>", "Filter by status")
    .option("--category <category>", "Filter by category")
    .option("--subcircuit <name>", "Filter by subcircuit")
    .option("--group-by <field>", "Group by category, subcircuit, or status")
    .action(async (opts) => {
      try {
        const result = await bomShow(opts);
        output(result, renderBomTable);
      } catch (e) {
        fatal((e as Error).message);
      }
    });

  bom
    .command("add")
    .description("Add a component to the BOM")
    .option("--role <role>", "Human-readable role (e.g. 'BLE antenna')")
    .option("--category <cat>", "Component category", "other")
    .option("--manufacturer <name>", "Manufacturer name")
    .option("--mpn <mpn>", "Manufacturer part number")
    .option("--lcsc <part>", "LCSC part number (e.g. C123456)")
    .option("--description <desc>", "Description")
    .option("--notes <notes>", "Placement/routing notes")
    .option("--selection-notes <notes>", "Why this part was chosen")
    .option("--datasheet-url <url>", "Datasheet URL")
    .option("--refs <refs>", "KiCad reference designators (comma-separated)")
    .option("--status <status>", "Initial status", "candidate")
    .action(async (opts) => {
      if (!opts.role && !opts.lcsc) {
        fatal("Provide --role or --lcsc (LCSC parts auto-populate the role)");
      }
      try {
        const result = await bomAdd({
          role: opts.role,
          category: opts.category,
          manufacturer: opts.manufacturer,
          mpn: opts.mpn,
          lcsc: opts.lcsc,
          description: opts.description,
          notes: opts.notes,
          selectionNotes: opts.selectionNotes,
          datasheetUrl: opts.datasheetUrl,
          refs: opts.refs ? opts.refs.split(",").map((r: string) => r.trim()) : undefined,
          status: opts.status,
        });
        output(result, renderAddResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });

  bom
    .command("remove <id>")
    .description("Remove a BOM entry by ID (or ID prefix)")
    .action(async (id: string) => {
      try {
        const result = await bomRemove(id);
        output(result, renderRemoveResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });

  bom
    .command("link <id> <refs>")
    .description("Link BOM entry to KiCad reference designators")
    .action(async (id: string, refs: string) => {
      try {
        const refList = refs.split(",").map((r) => r.trim());
        const result = await bomLink(id, refList);
        output(result, renderLinkResult);
      } catch (e) {
        fatal((e as Error).message);
      }
    });

  bom
    .command("check")
    .description("Verify BOM: check stock, packages, refs, and consistency")
    .option("--offline", "Skip LCSC API checks (local validation only)")
    .option("--from-jlcpcb", "Read BOM from jlcpcb/project.db instead of pcbpal.bom.json")
    .action(async (opts: { offline?: boolean; fromJlcpcb?: boolean }) => {
      try {
        let spinner: ReturnType<typeof clack.spinner> | null = null;
        if (isInteractive() && !opts.offline) {
          spinner = clack.spinner();
          spinner.start("Checking BOM against LCSC...");
        }

        const result = await bomCheck(
          { offline: opts.offline, fromJlcpcb: opts.fromJlcpcb },
          spinner
            ? (checked, total) => {
                spinner!.message(`Checking parts ${checked}/${total}...`);
              }
            : undefined,
        );

        if (spinner) spinner.stop("Done");
        output(result, renderCheckResult);
        if (!result.ok) process.exit(1);
      } catch (e) {
        fatal((e as Error).message);
      }
    });
}
