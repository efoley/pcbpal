import { readFile } from "node:fs/promises";
import { DatasheetExtraction } from "../../schemas/datasheet.js";
import { fetchComponentDetail, type LcscComponentDetail } from "../../services/lcsc.js";
import {
  crossCheckPackage,
  crossCheckSpecs,
  type DerivedNet,
  deriveNets,
  type Finding,
  validatePinTable,
  validateSpecTable,
} from "../../services/refcircuit.js";

export interface ValidateOptions {
  file: string;
  againstLcsc?: string;
}

export interface ValidateResult {
  ok: boolean;
  facet: "specs" | "pins" | "circuit";
  device: string;
  errors: Finding[];
  warnings: Finding[];
  nets?: DerivedNet[];
  stats: { components?: number; pins?: number; items?: number; nets?: number };
}

const FACETS = ["specs", "pins", "circuit"] as const;

/** Cross-check an extraction against LCSC data. Never throws on network error. */
async function lcscCrossCheck(lcscPart: string, data: DatasheetExtraction): Promise<Finding[]> {
  let detail: LcscComponentDetail;
  try {
    detail = await fetchComponentDetail(lcscPart);
  } catch {
    return [
      {
        severity: "warning",
        code: "lcsc_unreachable",
        message: `Could not fetch LCSC part ${lcscPart} for cross-check`,
        where: lcscPart,
      },
    ];
  }

  if (data.facet === "pins") {
    const f = crossCheckPackage(data.payload.package, detail.package);
    return f ? [f] : [];
  }
  if (data.facet === "specs") {
    // LcscComponentDetail does not currently expose parametric name/value
    // pairs; read them defensively so this works if lcsc.ts grows them later.
    const attrs = (detail as unknown as { attributes?: Record<string, string | number> })
      .attributes;
    if (attrs && typeof attrs === "object") {
      return crossCheckSpecs(data.payload.items, attrs);
    }
  }
  return [];
}

export async function validateExtraction(opts: ValidateOptions): Promise<ValidateResult> {
  let text: string;
  try {
    text = await readFile(opts.file, "utf-8");
  } catch {
    throw new Error(`Cannot read extraction file: ${opts.file}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Extraction file is not valid JSON: ${opts.file} (${(e as Error).message})`);
  }

  const parsed = DatasheetExtraction.safeParse(raw);
  if (!parsed.success) {
    const rawObj = (raw ?? {}) as Record<string, unknown>;
    const facet =
      typeof rawObj.facet === "string" && (FACETS as readonly string[]).includes(rawObj.facet)
        ? (rawObj.facet as ValidateResult["facet"])
        : "specs";
    const device = typeof rawObj.device === "string" ? rawObj.device : "";
    const errors: Finding[] = parsed.error.issues.map((iss) => ({
      severity: "error",
      code: "schema",
      message: iss.message,
      where: iss.path.join(".") || undefined,
    }));
    return { ok: false, facet, device, errors, warnings: [], stats: {} };
  }

  const data = parsed.data;
  const findings: Finding[] = [];
  const stats: ValidateResult["stats"] = {};
  let nets: DerivedNet[] | undefined;

  if (data.facet === "specs") {
    findings.push(...validateSpecTable(data.payload));
    stats.items = data.payload.items.length;
  } else if (data.facet === "pins") {
    findings.push(...validatePinTable(data.payload));
    stats.pins = data.payload.pins.length;
  } else {
    const derived = deriveNets(data.payload);
    findings.push(...derived.findings);
    nets = derived.nets;
    stats.components = data.payload.components.length;
    stats.nets = derived.nets.length;
  }

  if (opts.againstLcsc) {
    findings.push(...(await lcscCrossCheck(opts.againstLcsc, data)));
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");

  return {
    ok: errors.length === 0,
    facet: data.facet,
    device: data.device,
    errors,
    warnings,
    nets,
    stats,
  };
}
