/**
 * Unit parsing and normalization for datasheet spec values.
 *
 * Pure functions, no I/O. Used by the deterministic `datasheet validate`
 * checks to sanity-check units against a parameter's expected class and to
 * compare extracted values against LCSC parametric attributes.
 */

export type UnitClass =
  | "voltage"
  | "current"
  | "power"
  | "frequency"
  | "capacitance"
  | "inductance"
  | "resistance"
  | "temperature"
  | "time"
  | "percent"
  | "other";

// SI prefixes, canonicalized. "u"/"μ" fold into "µ"; "K" folds into "k".
const PREFIX_ALIASES: Record<string, string> = {
  p: "p",
  n: "n",
  u: "µ",
  µ: "µ",
  μ: "µ",
  m: "m",
  k: "k",
  K: "k",
  M: "M",
  G: "G",
};

const PREFIX_SCALE: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  µ: 1e-6,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
};

// Canonical base units.
const CANON_BASES = new Set([
  "V",
  "A",
  "W",
  "Hz",
  "F",
  "H",
  "Ω",
  "s",
  "°C",
  "%",
  "dB",
  "ppm",
  "bit",
  "byte",
]);

// Base-unit aliases → canonical base.
const BASE_ALIASES: Record<string, string> = {
  V: "V",
  A: "A",
  W: "W",
  Hz: "Hz",
  hz: "Hz",
  HZ: "Hz",
  F: "F",
  H: "H",
  s: "s",
  sec: "s",
  secs: "s",
  Ω: "Ω",
  ohm: "Ω",
  ohms: "Ω",
  Ohm: "Ω",
  Ohms: "Ω",
  OHM: "Ω",
  R: "Ω",
  "%": "%",
  dB: "dB",
  db: "dB",
  DB: "dB",
  ppm: "ppm",
  PPM: "ppm",
  bit: "bit",
  bits: "bit",
  byte: "byte",
  bytes: "byte",
};

const TEMPERATURE_RE = /^(deg\s*c|degc|℃|°c|c)$/i;

/** Resolve a base-unit token (already prefix-stripped) to its canonical form. */
function canonicalBase(token: string): string | null {
  if (token === "") return null;
  if (TEMPERATURE_RE.test(token)) return "°C";
  return BASE_ALIASES[token] ?? null;
}

/**
 * Canonicalize a unit string, preserving the SI-prefix + base structure.
 * Unknown units are returned trimmed but otherwise unchanged.
 */
export function normalizeUnit(unit: string): string {
  const s = unit.trim();
  if (s === "") return s;

  // Whole-string temperature spellings.
  if (TEMPERATURE_RE.test(s)) return "°C";

  // No-prefix base (checked first so "Hz", "dB" aren't split as H+z etc.).
  const direct = canonicalBase(s);
  if (direct !== null) return direct;

  // Prefix + base.
  const first = s[0];
  const prefix = PREFIX_ALIASES[first];
  if (prefix !== undefined) {
    const base = canonicalBase(s.slice(1));
    if (base !== null) return prefix + base;
  }

  return s;
}

/** Split a normalized unit into its prefix scale and canonical base. */
function toBase(unit: string): { scale: number; base: string } | null {
  const norm = normalizeUnit(unit);
  if (CANON_BASES.has(norm)) return { scale: 1, base: norm };
  const first = norm[0];
  const scale = PREFIX_SCALE[first];
  if (scale !== undefined) {
    const base = norm.slice(1);
    if (CANON_BASES.has(base)) return { scale, base };
  }
  return null;
}

/**
 * Parse a quantity like "10µF", "2.2 uH", "100kΩ", "0.5%", "-40°C".
 * Returns the value expressed in BASE units with a normalized base unit,
 * or null if no leading number / no unit is present.
 */
export function parseQuantity(text: string): { value: number; unit: string } | null {
  const t = text.trim();
  const m = t.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (Number.isNaN(value)) return null;
  const unitRaw = m[2].trim();
  if (unitRaw === "") return null;

  const tb = toBase(unitRaw);
  if (tb) {
    return { value: value * tb.scale, unit: tb.base };
  }
  // Unknown unit: keep value as-is with the normalized (unchanged) unit.
  return { value, unit: normalizeUnit(unitRaw) };
}

/** Reduce a normalized unit to its canonical base (strip a known prefix). */
function baseOf(unit: string): string {
  const norm = normalizeUnit(unit);
  if (CANON_BASES.has(norm)) return norm;
  const first = norm[0];
  if (PREFIX_SCALE[first] !== undefined) {
    const base = norm.slice(1);
    if (CANON_BASES.has(base)) return base;
  }
  return norm;
}

/** Classify a unit into a broad physical-quantity class. */
export function unitClassOf(unit: string): UnitClass {
  const base = baseOf(unit);
  switch (base) {
    case "V":
      return "voltage";
    case "A":
      return "current";
    case "W":
      return "power";
    case "Hz":
      return "frequency";
    case "F":
      return "capacitance";
    case "H":
      return "inductance";
    case "Ω":
      return "resistance";
    case "°C":
      return "temperature";
    case "s":
      return "time";
    case "%":
      return "percent";
    default:
      return "other";
  }
}

/**
 * Infer the expected unit class from a parameter name (and optional symbol).
 * Conservative: returns null when the signals are absent or contradictory.
 */
export function inferExpectedClass(parameter: string, symbol?: string): UnitClass | null {
  const p = parameter.toLowerCase();

  const hits = new Set<UnitClass>();
  if (p.includes("voltage") || /\bv_/i.test(parameter)) hits.add("voltage");
  if (p.includes("current")) hits.add("current");
  if (p.includes("resistance")) hits.add("resistance");
  if (p.includes("capacitance")) hits.add("capacitance");
  if (p.includes("inductance")) hits.add("inductance");
  if (p.includes("frequency")) hits.add("frequency");
  if (p.includes("temperature")) hits.add("temperature");
  if (p.includes("power")) hits.add("power");
  if (p.includes("time") || p.includes("delay")) hits.add("time");

  if (hits.size === 1) return [...hits][0];
  if (hits.size > 1) return null; // ambiguous parameter name

  // Fall back to the symbol's leading letter (case-sensitive: f/F, t/T differ).
  if (symbol && symbol.length > 0) {
    const c = symbol[0];
    switch (c) {
      case "V":
        return "voltage";
      case "I":
        return "current";
      case "T":
        return "temperature";
      case "f":
        return "frequency";
      case "R":
        return "resistance";
      case "C":
        return "capacitance";
      case "L":
        return "inductance";
      case "P":
        return "power";
      case "t":
        return "time";
      default:
        return null;
    }
  }

  return null;
}
