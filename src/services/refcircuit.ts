/**
 * Deterministic reference-circuit / pin-table / spec-table checks.
 *
 * Pure logic, no I/O. Consumed by `datasheet validate` (core module). Net
 * derivation is a union-find over pin references and named rails; every check
 * emits structured Findings rather than throwing, so a caller can report all
 * problems at once.
 */

import type { PinTable, ReferenceCircuit, SpecItem, SpecTable } from "../schemas/datasheet.js";
import { inferExpectedClass, parseQuantity, unitClassOf } from "../util/units.js";

export interface Finding {
  severity: "error" | "warning";
  code: string;
  message: string;
  where?: string;
}

export interface DerivedNet {
  name: string;
  members: string[]; // "REF.PIN" strings
}

// ── Union-find over string node names ──

class UnionFind {
  private parent = new Map<string, string>();

  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }

  find(x: string): string {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root) as string;
    }
    // path compression
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      // deterministic: smaller root name wins
      if (ra < rb) this.parent.set(rb, ra);
      else this.parent.set(ra, rb);
    }
  }

  nodes(): string[] {
    return [...this.parent.keys()];
  }
}

const isPinRef = (s: string): boolean => s.includes(".");

/**
 * Derive nets from a reference circuit's component pin connections and run the
 * deterministic topology checks.
 */
export function deriveNets(circuit: ReferenceCircuit): {
  nets: DerivedNet[];
  findings: Finding[];
} {
  const findings: Finding[] = [];
  const uf = new UnionFind();

  const declared = new Set<string>();
  const pinsByComp = new Map<string, Set<string>>();
  const connByPin = new Map<string, string[]>();

  for (const comp of circuit.components) {
    declared.add(comp.designator);
    const set = pinsByComp.get(comp.designator) ?? new Set<string>();
    for (const p of comp.pins) {
      set.add(p.pin);
      connByPin.set(`${comp.designator}.${p.pin}`, p.connects_to);
    }
    pinsByComp.set(comp.designator, set);
  }

  const railsDeclared = new Set(circuit.rails);
  const railsReferenced = new Set<string>();
  const undeclaredRailSeen = new Set<string>();

  for (const comp of circuit.components) {
    for (const pinDef of comp.pins) {
      const self = `${comp.designator}.${pinDef.pin}`;
      const conns = pinDef.connects_to;

      // Note: NC-only / dangling pins are deliberately NOT added as nodes, so
      // they don't surface as spurious singleton nets. union() below adds a
      // pin node exactly when it has a real (non-NC) connection.
      if (conns.length === 0) {
        findings.push({
          severity: "error",
          code: "dangling_pin",
          message: `Pin ${self} has no connections; list at least one net or ["NC"]`,
          where: self,
        });
        continue;
      }

      const hasNC = conns.includes("NC");
      const others = conns.filter((c) => c !== "NC");

      if (hasNC && others.length > 0) {
        findings.push({
          severity: "error",
          code: "nc_conflict",
          message: `Pin ${self} is marked NC but also lists connections: ${others.join(", ")}`,
          where: self,
        });
      }

      for (const target of others) {
        if (isPinRef(target)) {
          const dot = target.indexOf(".");
          const ref = target.slice(0, dot);
          const pinName = target.slice(dot + 1);
          if (!declared.has(ref)) {
            findings.push({
              severity: "error",
              code: "undeclared_component",
              message: `Pin ${self} connects to ${target}, but component ${ref} is not declared`,
              where: self,
            });
          } else if (!(pinsByComp.get(ref) as Set<string>).has(pinName)) {
            findings.push({
              severity: "error",
              code: "unknown_pin",
              message: `Pin ${self} connects to ${target}, but ${ref} has no pin ${pinName}`,
              where: self,
            });
          }
          uf.union(self, target);
        } else {
          // named rail
          railsReferenced.add(target);
          uf.union(self, target);
          if (!railsDeclared.has(target) && !undeclaredRailSeen.has(target)) {
            undeclaredRailSeen.add(target);
            findings.push({
              severity: "warning",
              code: "undeclared_rail",
              message: `Rail "${target}" is used but not listed in rails[]`,
              where: target,
            });
          }
        }
      }
    }
  }

  // Reciprocation check (warnings).
  for (const comp of circuit.components) {
    for (const pinDef of comp.pins) {
      const self = `${comp.designator}.${pinDef.pin}`;
      const aConns = pinDef.connects_to;
      const aRails = aConns.filter((c) => !isPinRef(c) && c !== "NC");
      for (const target of aConns) {
        if (!isPinRef(target)) continue;
        const bConns = connByPin.get(target);
        if (bConns === undefined) continue; // undeclared/unknown pin already flagged
        const reciprocatedDirect = bConns.includes(self);
        const sharedRail = aRails.some((r) => bConns.includes(r));
        if (!reciprocatedDirect && !sharedRail) {
          findings.push({
            severity: "warning",
            code: "unreciprocated_connection",
            message: `${self} connects to ${target}, but ${target} does not connect back (directly or via a shared rail)`,
            where: `${self} -> ${target}`,
          });
        }
      }
    }
  }

  // unused_rail warnings.
  for (const rail of circuit.rails) {
    if (!railsReferenced.has(rail)) {
      findings.push({
        severity: "warning",
        code: "unused_rail",
        message: `Rail "${rail}" is declared but never referenced by any pin`,
        where: rail,
      });
    }
  }

  // Group nodes into nets.
  const groups = new Map<string, string[]>();
  for (const node of uf.nodes()) {
    const root = uf.find(node);
    const g = groups.get(root) ?? [];
    g.push(node);
    groups.set(root, g);
  }

  const railNets: DerivedNet[] = [];
  const synthNets: { members: string[] }[] = [];

  for (const g of groups.values()) {
    const members = g.filter(isPinRef).sort();
    const railsInNet = g.filter((n) => !isPinRef(n)).sort();

    if (railsInNet.length >= 2) {
      findings.push({
        severity: "warning",
        code: "rail_short",
        message: `Rails ${railsInNet.join(", ")} are shorted together in one net`,
        where: railsInNet.join(","),
      });
    }

    if (railsInNet.length >= 1) {
      railNets.push({ name: railsInNet[0], members });
    } else {
      synthNets.push({ members });
    }
  }

  // Deterministic synthetic naming by first member in sorted order.
  synthNets.sort((a, b) => (a.members[0] ?? "").localeCompare(b.members[0] ?? ""));
  const synthNamed: DerivedNet[] = synthNets.map((n, i) => ({
    name: `N$${i + 1}`,
    members: n.members,
  }));

  const nets = [...railNets, ...synthNamed].sort((a, b) => a.name.localeCompare(b.name));

  // singleton_net warnings.
  for (const net of nets) {
    if (net.members.length === 1) {
      findings.push({
        severity: "warning",
        code: "singleton_net",
        message: `Net ${net.name} has only one pin member (${net.members[0]})`,
        where: net.members[0],
      });
    }
  }

  return { nets, findings };
}

// ── Pin-table checks ──

/** Parse the trailing integer pin count from a package name, or null. */
function packagePinCount(pkg: string): number | null {
  const m = pkg.trim().match(/(\d+)\s*$/);
  return m ? Number.parseInt(m[1], 10) : null;
}

const EP_RE = /^(ep|pad|epad)$/i;

export function validatePinTable(pins: PinTable): Finding[] {
  const findings: Finding[] = [];

  if (pins.pins.length !== pins.pin_count) {
    findings.push({
      severity: "error",
      code: "pin_count_mismatch",
      message: `pin_count is ${pins.pin_count} but pins[] has ${pins.pins.length} entries`,
    });
  }

  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const p of pins.pins) {
    if (seen.has(p.number)) dupes.add(p.number);
    seen.add(p.number);
  }
  for (const number of dupes) {
    findings.push({
      severity: "error",
      code: "duplicate_pin",
      message: `Pin number "${number}" appears more than once`,
      where: number,
    });
  }

  const expected = packagePinCount(pins.package);
  if (expected !== null) {
    const hasEP = pins.pins.some((p) => EP_RE.test(p.number) || EP_RE.test(p.name));
    const allowed = hasEP ? [expected, expected + 1] : [expected];
    if (!allowed.includes(pins.pin_count)) {
      findings.push({
        severity: "warning",
        code: "package_pin_count",
        message: `Package "${pins.package}" implies ${expected} pins${
          hasEP ? " (+1 for exposed pad)" : ""
        } but pin_count is ${pins.pin_count}`,
        where: pins.package,
      });
    }
  }

  return findings;
}

// ── Spec-table checks ──

export function validateSpecTable(specs: SpecTable): Finding[] {
  const findings: Finding[] = [];

  for (const item of specs.items) {
    const where = item.symbol ?? item.parameter;
    const { min, typ, max, unit } = item.value;

    if (min === undefined && typ === undefined && max === undefined) {
      findings.push({
        severity: "error",
        code: "no_value",
        message: `"${item.parameter}" has none of min/typ/max`,
        where,
      });
    }

    // Ordering min ≤ typ ≤ max among present values.
    const ordered: [string, number, string, number][] = [];
    if (min !== undefined && typ !== undefined) ordered.push(["min", min, "typ", typ]);
    if (typ !== undefined && max !== undefined) ordered.push(["typ", typ, "max", max]);
    if (min !== undefined && max !== undefined) ordered.push(["min", min, "max", max]);
    for (const [aName, a, bName, b] of ordered) {
      if (a > b) {
        findings.push({
          severity: "error",
          code: "min_typ_max_order",
          message: `"${item.parameter}": ${aName} (${a}) > ${bName} (${b})`,
          where,
        });
      }
    }

    if (unit.trim() === "") {
      findings.push({
        severity: "error",
        code: "empty_unit",
        message: `"${item.parameter}" has an empty unit`,
        where,
      });
      continue;
    }

    const expected = inferExpectedClass(item.parameter, item.symbol);
    const actual = unitClassOf(unit);
    if (expected !== null && actual !== "other" && actual !== expected) {
      findings.push({
        severity: "warning",
        code: "unit_class_mismatch",
        message: `"${item.parameter}" looks like ${expected} but unit "${unit}" is ${actual}`,
        where,
      });
    }
  }

  return findings;
}

// ── LCSC cross-check helpers (pure; no network) ──

/** Normalize a package string for case/hyphen-insensitive comparison. */
export function normalizePackageName(pkg: string): string {
  return pkg.toLowerCase().replace(/[\s_-]+/g, "");
}

/** True if two package names plausibly refer to the same package. */
export function packagesMatch(a: string, b: string): boolean {
  const na = normalizePackageName(a);
  const nb = normalizePackageName(b);
  if (na === "" || nb === "") return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Compare two quantity strings; returns the relative difference (0..∞) if both
 * parse to the same base unit, or null if incomparable.
 */
export function relativeQuantityDiff(a: string, b: string): number | null {
  const qa = parseQuantity(a);
  const qb = parseQuantity(b);
  if (!qa || !qb) return null;
  if (qa.unit !== qb.unit) return null;
  if (qa.value === 0 && qb.value === 0) return 0;
  const denom = Math.max(Math.abs(qa.value), Math.abs(qb.value));
  if (denom === 0) return null;
  return Math.abs(qa.value - qb.value) / denom;
}

/** Fuzzy name match for parameter ↔ LCSC attribute keys. */
export function fuzzyNameMatch(a: string, b: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const na = norm(a);
  const nb = norm(b);
  if (na === "" || nb === "") return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Compare an extracted package string against an LCSC package string. */
export function crossCheckPackage(extracted: string, lcsc: string): Finding | null {
  if (!extracted || !lcsc) return null;
  if (packagesMatch(extracted, lcsc)) return null;
  return {
    severity: "warning",
    code: "lcsc_package_mismatch",
    message: `Extracted package "${extracted}" does not match LCSC package "${lcsc}"`,
    where: extracted,
  };
}

/**
 * Cross-check extracted spec items against LCSC parametric attributes.
 * Emits a warning where a fuzzy-name-matched parameter's value disagrees by
 * more than 5%. Pure — the caller supplies the already-fetched attributes.
 */
export function crossCheckSpecs(
  items: SpecItem[],
  attributes: Record<string, string | number>,
): Finding[] {
  const findings: Finding[] = [];
  const entries = Object.entries(attributes);
  for (const item of items) {
    const where = item.symbol ?? item.parameter;
    const match = entries.find(
      ([k]) =>
        fuzzyNameMatch(item.parameter, k) ||
        (item.symbol !== undefined && fuzzyNameMatch(item.symbol, k)),
    );
    if (!match) continue;
    const [attrName, attrVal] = match;
    const rep = item.value.typ ?? item.value.min ?? item.value.max;
    if (rep === undefined) continue;
    const diff = relativeQuantityDiff(`${rep}${item.value.unit}`, String(attrVal));
    if (diff !== null && diff > 0.05) {
      findings.push({
        severity: "warning",
        code: "lcsc_value_mismatch",
        message: `"${item.parameter}" = ${rep}${item.value.unit} disagrees with LCSC ${attrName} = ${attrVal}`,
        where,
      });
    }
  }
  return findings;
}
