import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
