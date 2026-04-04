import { exists, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { findProjectRoot } from "../../services/project.js";

export interface LibFetchOptions {
  lcsc: string;
  symbol?: boolean;
  footprint?: boolean;
  model3d?: boolean;
}

export interface LibFetchResult {
  ok: true;
  lcsc: string;
  symbolPath: string | null;
  footprintDir: string | null;
  modelPath: string | null;
}

/** Check whether easyeda2kicad is installed and callable. */
export async function checkEasyeda2kicad(): Promise<{ ok: boolean; message: string }> {
  try {
    const proc = Bun.spawn(["easyeda2kicad", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0
      ? { ok: true, message: "easyeda2kicad is installed" }
      : { ok: false, message: "easyeda2kicad returned an error" };
  } catch {
    return {
      ok: false,
      message:
        "easyeda2kicad not found — install with: pipx install easyeda2kicad",
    };
  }
}

// ── lib install ──

export interface LibInstallResult {
  ok: true;
  symbolsAdded: string[];
  footprintsAdded: string[];
  symbolsExisting: number;
  footprintsExisting: number;
}

/**
 * Parse a KiCad library table file and return the set of library names already present.
 */
function parseLibTableNames(content: string): Set<string> {
  const names = new Set<string>();
  const regex = /\(lib\s+\(name\s+"([^"]+)"\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    names.add(match[1]);
  }
  return names;
}

/**
 * Add library entries to a KiCad library table file.
 * Creates the file if it doesn't exist.
 */
async function addToLibTable(
  tablePath: string,
  tableType: "sym_lib_table" | "fp_lib_table",
  entries: { name: string; uri: string }[],
): Promise<string[]> {
  let content: string;
  let existingNames: Set<string>;

  if (await exists(tablePath)) {
    content = await readFile(tablePath, "utf-8");
    existingNames = parseLibTableNames(content);
  } else {
    content = `(${tableType}\n  (version 7)\n)\n`;
    existingNames = new Set();
  }

  const added: string[] = [];
  const newLines: string[] = [];

  for (const entry of entries) {
    if (existingNames.has(entry.name)) continue;
    newLines.push(
      `  (lib (name "${entry.name}")(type "KiCad")(uri "${entry.uri}")(options "")(descr "pcbpal"))`,
    );
    added.push(entry.name);
  }

  if (newLines.length === 0) return added;

  // Insert new entries before the closing paren
  const closingIdx = content.lastIndexOf(")");
  const before = content.slice(0, closingIdx);
  const updated = before + newLines.join("\n") + "\n)\n";
  await writeFile(tablePath, updated, "utf-8");

  return added;
}

const PCBPAL_LIB_NAME = "pcbpal";

/**
 * Remove library table entries whose names are in the given set
 * (old per-component pcbpal entries like "C173752").
 */
async function removePcbpalEntries(
  tablePath: string,
  namesToRemove: Set<string>,
): Promise<void> {
  if (!(await exists(tablePath))) return;
  const content = await readFile(tablePath, "utf-8");
  const lines = content.split("\n");
  const filtered = lines.filter((line) => {
    const nameMatch = line.match(/\(lib\s+\(name\s+"([^"]+)"\)/);
    if (!nameMatch) return true;
    return !namesToRemove.has(nameMatch[1]);
  });
  await writeFile(tablePath, filtered.join("\n"), "utf-8");
}

/**
 * Merge all individual .kicad_sym files into a single pcbpal.kicad_sym,
 * and consolidate all .pretty footprints into a single pcbpal.pretty dir.
 * This gives a clean "pcbpal" category in KiCad's symbol/footprint chooser.
 */
export async function libInstall(): Promise<LibInstallResult> {
  const root = await findProjectRoot();
  if (!root) throw new Error("Not in a pcbpal project (no pcbpal.toml found)");

  const libDir = join(root, ".pcbpal", "lib");
  if (!(await exists(libDir))) {
    return { ok: true, symbolsAdded: [], footprintsAdded: [], symbolsExisting: 0, footprintsExisting: 0 };
  }

  const files = await readdir(libDir);
  // Exclude the merged output files from the input list
  const symFiles = files.filter((f) => f.endsWith(".kicad_sym") && f !== `${PCBPAL_LIB_NAME}.kicad_sym`);
  const prettyDirs = files.filter((f) => f.endsWith(".pretty") && f !== `${PCBPAL_LIB_NAME}.pretty`);

  // ── Merge symbols into pcbpal.kicad_sym ──
  const symbolsAdded: string[] = [];
  const symbolBlocks: string[] = [];

  for (const symFile of symFiles) {
    const content = await readFile(join(libDir, symFile), "utf-8");
    const lcsc = symFile.replace(".kicad_sym", "");

    // Extract symbol blocks from the file (everything between the outer parens)
    // Each file has: (kicad_symbol_lib (version ...) (generator ...) (symbol "Name" ...))
    const symbolRegex = /(\(symbol\s+"[^"]+?"[\s\S]*?\n\s{2}\))/g;
    let match: RegExpExecArray | null;
    while ((match = symbolRegex.exec(content)) !== null) {
      let block = match[1];
      // Rewrite Footprint property: "C173752:FP_NAME" → "pcbpal:FP_NAME"
      block = block.replace(
        /(\(property\s+"Footprint"\s+")([^":]+):([^"]+)(")/g,
        `$1${PCBPAL_LIB_NAME}:$3$4`,
      );
      symbolBlocks.push(block);
      symbolsAdded.push(lcsc);
    }
  }

  if (symbolBlocks.length > 0) {
    // Write a merged file, then upgrade it to KiCad 9 format via kicad-cli
    const mergedPath = join(libDir, `${PCBPAL_LIB_NAME}.kicad_sym`);
    const merged = [
      "(kicad_symbol_lib",
      "  (version 20211014)",
      '  (generator "pcbpal")',
      ...symbolBlocks.map((b) => "  " + b.replace(/\n/g, "\n  ")),
      ")",
      "",
    ].join("\n");
    await writeFile(mergedPath, merged, "utf-8");

    // Upgrade to current KiCad format (adds exclude_from_sim, fixes indentation, etc.)
    const tmpPath = mergedPath + ".tmp";
    const upgradeProc = Bun.spawn(
      ["kicad-cli", "sym", "upgrade", mergedPath, "--force", "-o", tmpPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    await new Response(upgradeProc.stdout).text();
    const exitCode = await upgradeProc.exited;
    if (exitCode === 0 && (await exists(tmpPath))) {
      const { rename } = await import("node:fs/promises");
      await rename(tmpPath, mergedPath);
    }
  }

  // ── Consolidate footprints into pcbpal.pretty ──
  const { copyFile } = await import("node:fs/promises");
  const mergedPrettyDir = join(libDir, `${PCBPAL_LIB_NAME}.pretty`);
  await mkdir(mergedPrettyDir, { recursive: true });

  const footprintsAdded: string[] = [];
  for (const prettyDir of prettyDirs) {
    if (prettyDir === `${PCBPAL_LIB_NAME}.pretty`) continue;
    const lcsc = prettyDir.replace(".pretty", "");
    const srcDir = join(libDir, prettyDir);
    const modFiles = (await readdir(srcDir)).filter((f) => f.endsWith(".kicad_mod"));
    for (const modFile of modFiles) {
      await copyFile(join(srcDir, modFile), join(mergedPrettyDir, modFile));
      footprintsAdded.push(`${lcsc}/${modFile}`);
    }
  }

  // ── Register in library tables ──
  // Remove old per-component pcbpal entries, keep the single merged one
  const symTablePath = join(root, "sym-lib-table");
  const fpTablePath = join(root, "fp-lib-table");

  const lcscNames = new Set([
    ...symFiles.map((f) => f.replace(".kicad_sym", "")),
    ...prettyDirs.filter((d) => d !== `${PCBPAL_LIB_NAME}.pretty`).map((d) => d.replace(".pretty", "")),
  ]);
  await removePcbpalEntries(symTablePath, lcscNames);
  await removePcbpalEntries(fpTablePath, lcscNames);

  const symUri = `\${KIPRJMOD}/${relative(root, join(libDir, `${PCBPAL_LIB_NAME}.kicad_sym`))}`;
  const fpUri = `\${KIPRJMOD}/${relative(root, join(libDir, `${PCBPAL_LIB_NAME}.pretty`))}`;

  await addToLibTable(symTablePath, "sym_lib_table", [{ name: PCBPAL_LIB_NAME, uri: symUri }]);
  await addToLibTable(fpTablePath, "fp_lib_table", [{ name: PCBPAL_LIB_NAME, uri: fpUri }]);

  return {
    ok: true,
    symbolsAdded,
    footprintsAdded,
    symbolsExisting: 0,
    footprintsExisting: 0,
  };
}

// ── lib fetch ──

export async function libFetch(opts: LibFetchOptions): Promise<LibFetchResult> {
  const root = await findProjectRoot();
  if (!root) {
    throw new Error("Not in a pcbpal project (no pcbpal.toml found)");
  }

  const check = await checkEasyeda2kicad();
  if (!check.ok) {
    throw new Error(check.message);
  }

  // Default: fetch everything
  const fetchAll = !opts.symbol && !opts.footprint && !opts.model3d;

  const libDir = join(root, ".pcbpal", "lib");
  await mkdir(libDir, { recursive: true });

  const args = ["easyeda2kicad", "--lcsc_id", opts.lcsc, "--output", join(libDir, opts.lcsc)];

  if (fetchAll || opts.symbol) args.push("--symbol");
  if (fetchAll || opts.footprint) args.push("--footprint");
  if (fetchAll || opts.model3d) args.push("--3d");

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const msg = stderr.trim() || stdout.trim() || "easyeda2kicad failed";
    throw new Error(`easyeda2kicad exited with code ${exitCode}: ${msg}`);
  }

  // easyeda2kicad writes files based on --output prefix:
  //   <output>.kicad_sym  (symbol library)
  //   <output>.pretty/    (footprint library dir containing .kicad_mod files)
  //   <output>.wrl        (3D model)
  const { exists } = await import("node:fs/promises");

  const symPath = join(libDir, `${opts.lcsc}.kicad_sym`);
  const fpDir = join(libDir, `${opts.lcsc}.pretty`);
  const modelPath = join(libDir, `${opts.lcsc}.wrl`);

  const symbolPath = (await exists(symPath)) ? symPath : null;
  const footprintDir = (await exists(fpDir)) ? fpDir : null;
  const modelResult = (await exists(modelPath)) ? modelPath : null;

  if (!symbolPath && !footprintDir && !modelResult) {
    throw new Error(
      `easyeda2kicad produced no output files for ${opts.lcsc} — component may not exist`,
    );
  }

  return {
    ok: true,
    lcsc: opts.lcsc,
    symbolPath,
    footprintDir,
    modelPath: modelResult,
  };
}
