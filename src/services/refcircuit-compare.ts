/**
 * Circuit comparison — the referee for `datasheet diff` and the eval harness's
 * `score-circuit.ts`. Pure logic, no I/O.
 *
 * Both sides are reduced to a neutral `CanonicalCircuit` (components + nets as
 * sets of pin refs). Designators are arbitrary, so components are matched by
 * kind (hard) and value/pin-count (soft preference), choosing the matching that
 * maximizes connection agreement. Connectivity is then compared as pin-pair
 * adjacency translated through that matching.
 *
 * Pin-name subtlety for ICs: golden figures name pins ("FB", "SW") while a
 * KiCad netlist may expose numbers ("1", "2"). When both sides name pins we map
 * them by name (case-insensitively); when one side numbers and the other names,
 * we cannot align individual pins, so for that component pair we collapse its
 * pins to a single node ("<id>.*") on BOTH sides. Collapsing symmetrically means
 * the relaxation shrinks the golden and candidate pair sets consistently and
 * therefore can never inflate F1 (a spurious agreement would require the same
 * collapsed pair to appear on both sides, which is exactly a real component-level
 * adjacency).
 */

import type { ReferenceCircuit } from "../schemas/datasheet.js";
import { parseQuantity } from "../util/units.js";
import type { Netlist } from "./netlist.js";
import { deriveNets } from "./refcircuit.js";

// ── Canonical form ──

export interface CanonicalComponent {
  id: string; // designator; arbitrary, NOT used for matching
  kind: string; // "resistor" | "capacitor" | ... (RefCircuitComponent kinds)
  value?: string; // raw printed value
  pinCount: number;
}

export interface CanonicalCircuit {
  components: CanonicalComponent[];
  // nets as sets of pin refs "id.pin"; net names matter only for rails/reporting
  nets: { name: string; members: string[] }[];
}

export interface CircuitComparison {
  matching: { goldenId: string; candidateId: string }[];
  unmatchedGolden: string[];
  unmatchedCandidate: string[];
  valueMismatches: {
    goldenId: string;
    candidateId: string;
    goldenValue?: string;
    candidateValue?: string;
  }[];
  missingConnections: { net: string; pins: string[] }[];
  extraConnections: { net: string; pins: string[] }[];
  metrics: {
    componentRecall: number;
    componentPrecision: number;
    valueAccuracy: number;
    connectionF1: number;
    netExactness: number;
    topologyPass: boolean;
  };
}

// ── Canonicalization: reference circuit ──

/** Build a canonical circuit from an extracted reference circuit. */
export function fromReferenceCircuit(circuit: ReferenceCircuit): CanonicalCircuit {
  const { nets } = deriveNets(circuit);
  const components: CanonicalComponent[] = circuit.components.map((c) => ({
    id: c.designator,
    kind: c.kind,
    value: c.value,
    pinCount: c.pins.length,
  }));
  return {
    components,
    nets: nets.map((n) => ({ name: n.name, members: [...n.members] })),
  };
}

// ── Canonicalization: KiCad netlist ──

/** Strip a leading "/" from a hierarchical KiCad net name; no other renaming. */
function normalizeRailName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

/** Map a KiCad reference designator + value/libPart to a canonical kind. */
export function kindFromRef(ref: string, value: string, libPart: string): string {
  const prefix = (ref.match(/^[A-Za-z]+/)?.[0] ?? "").toUpperCase();
  const hay = `${value} ${libPart}`.toLowerCase();
  switch (prefix) {
    case "R":
      return "resistor";
    case "C":
      return "capacitor";
    case "L":
      return "inductor";
    case "FB":
      return "ferrite";
    case "D":
      return hay.includes("led") ? "led" : "diode";
    case "Q":
      return "transistor";
    case "U":
      return "ic";
    case "Y":
    case "X":
      return "crystal";
    case "J":
    case "CN":
      return "connector";
    default:
      return "other";
  }
}

const isPowerSymbol = (ref: string): boolean => ref.startsWith("#");

/**
 * Choose the pin token for a netlist node: prefer a meaningful pin function
 * name (so IC pins align with datasheet figure names), else the pin number.
 */
function pinLabelOf(pin: string, pinFunction: string): string {
  const fn = pinFunction.trim();
  if (fn !== "" && fn !== "~" && fn !== pin) return fn;
  return pin;
}

/**
 * Build a canonical circuit from a KiCad netlist. If `opts.refs` is given, only
 * those components are kept and nets are dropped once fewer than 2 in-scope
 * members remain.
 */
export function fromKicadNetlist(netlist: Netlist, opts: { refs?: string[] }): CanonicalCircuit {
  const scope = opts.refs ? new Set(opts.refs) : null;
  const inScope = (ref: string): boolean =>
    !isPowerSymbol(ref) && (scope === null || scope.has(ref));

  const pinsByRef = new Map<string, Set<string>>();
  const nets: { name: string; members: string[] }[] = [];

  for (const net of netlist.nets) {
    const members: string[] = [];
    for (const node of net.nodes) {
      if (!inScope(node.ref)) continue;
      const token = pinLabelOf(node.pin, node.pinFunction);
      members.push(`${node.ref}.${token}`);
      const set = pinsByRef.get(node.ref) ?? new Set<string>();
      set.add(token);
      pinsByRef.set(node.ref, set);
    }
    if (members.length >= 2) {
      nets.push({ name: normalizeRailName(net.name), members: members.sort() });
    }
  }

  const components: CanonicalComponent[] = netlist.components
    .filter((c) => inScope(c.ref))
    .map((c) => ({
      id: c.ref,
      kind: kindFromRef(c.ref, c.value, c.libPart),
      value: c.value === "" ? undefined : c.value,
      pinCount: pinsByRef.get(c.ref)?.size ?? 0,
    }));

  return { components, nets };
}

// ── Value comparison ──

const RELATIVE_TOLERANCE = 0.01;

function normalizeValueString(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "").replace(/[µμ]/g, "u");
}

export function valueComparable(a?: string, b?: string): "equal" | "different" | "incomparable" {
  if (a === undefined || b === undefined) return "incomparable";
  const qa = parseQuantity(a);
  const qb = parseQuantity(b);
  if (qa && qb) {
    if (qa.unit !== qb.unit) return "different";
    const denom = Math.max(Math.abs(qa.value), Math.abs(qb.value));
    if (denom === 0) return "equal";
    return Math.abs(qa.value - qb.value) / denom <= RELATIVE_TOLERANCE ? "equal" : "different";
  }
  // Either side unparseable: fall back to normalized string compare.
  return normalizeValueString(a) === normalizeValueString(b) ? "equal" : "different";
}

export function valuesEquivalent(a?: string, b?: string): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return valueComparable(a, b) === "equal";
}

// ── Component matching ──

type Pair = [string, string]; // [goldenId, candidateId]

function groupByKind(comps: CanonicalComponent[]): Map<string, CanonicalComponent[]> {
  const m = new Map<string, CanonicalComponent[]>();
  for (const c of comps) {
    const g = m.get(c.kind) ?? [];
    g.push(c);
    m.set(c.kind, g);
  }
  return m;
}

/** All maximum-coverage injections mapping `a` (smaller/equal) into `b`. */
function injections(a: string[], b: string[]): Pair[][] {
  const res: Pair[][] = [];
  const used = new Array(b.length).fill(false);
  const acc: Pair[] = [];
  const rec = (i: number): void => {
    if (i === a.length) {
      res.push([...acc]);
      return;
    }
    for (let j = 0; j < b.length; j++) {
      if (used[j]) continue;
      used[j] = true;
      acc.push([a[i], b[j]]);
      rec(i + 1);
      acc.pop();
      used[j] = false;
    }
  };
  rec(0);
  return res;
}

/** Maximum-coverage matchings for one kind group (golden ↔ candidate ids). */
function kindMatchings(golden: string[], candidate: string[]): Pair[][] {
  if (golden.length === 0 || candidate.length === 0) return [[]];
  if (golden.length <= candidate.length) return injections(golden, candidate);
  // More golden than candidate: match each candidate to a distinct golden.
  return injections(candidate, golden).map((opt) => opt.map(([c, g]) => [g, c] as Pair));
}

const MAX_EXHAUSTIVE_COMBOS = 20000;

function greedyMatching(golden: CanonicalCircuit, candidate: CanonicalCircuit): Pair[] {
  const byKindG = groupByKind(golden.components);
  const byKindC = groupByKind(candidate.components);
  const pairs: Pair[] = [];
  for (const [kind, gList] of byKindG) {
    const cList = byKindC.get(kind) ?? [];
    const used = new Array(cList.length).fill(false);
    for (const g of gList) {
      let best = -1;
      let bestScore: [number, number] = [-1, -1];
      for (let j = 0; j < cList.length; j++) {
        if (used[j]) continue;
        const c = cList[j];
        const score: [number, number] = [
          valuesEquivalent(g.value, c.value) ? 1 : 0,
          g.pinCount === c.pinCount ? 1 : 0,
        ];
        if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
          bestScore = score;
          best = j;
        }
      }
      if (best >= 0) {
        used[best] = true;
        pairs.push([g.id, cList[best].id]);
      }
    }
  }
  return pairs;
}

interface Scored {
  pairs: Pair[];
  comparison: CircuitComparison;
  score: [number, number, number]; // [agreeing pairs, value-equal count, pin-count-equal count]
}

/**
 * Choose the component matching. Exhaustive over the joint product of per-kind
 * injections when the search space is small (the common case — group sizes are
 * tiny in practice); greedy fallback beyond the cap.
 */
export function chooseMatching(
  golden: CanonicalCircuit,
  candidate: CanonicalCircuit,
  force?: "greedy" | "exhaustive",
): Pair[] {
  return best(golden, candidate, force).pairs;
}

function best(
  golden: CanonicalCircuit,
  candidate: CanonicalCircuit,
  force?: "greedy" | "exhaustive",
): Scored {
  const byKindG = groupByKind(golden.components);
  const byKindC = groupByKind(candidate.components);

  const perKind: Pair[][][] = [];
  let combos = 1;
  for (const [kind, gList] of byKindG) {
    const cList = byKindC.get(kind) ?? [];
    const options = kindMatchings(
      gList.map((c) => c.id),
      cList.map((c) => c.id),
    );
    perKind.push(options);
    combos *= options.length;
  }

  const useGreedy =
    force === "greedy" || (force !== "exhaustive" && combos > MAX_EXHAUSTIVE_COMBOS);
  if (useGreedy) {
    const pairs = greedyMatching(golden, candidate);
    return { pairs, comparison: evaluate(pairs, golden, candidate).comparison, score: [0, 0, 0] };
  }

  // Cartesian product across kinds.
  let joint: Pair[][] = [[]];
  for (const options of perKind) {
    const next: Pair[][] = [];
    for (const combo of joint) {
      for (const opt of options) next.push([...combo, ...opt]);
    }
    joint = next;
  }

  let winner: Scored | null = null;
  for (const pairs of joint) {
    const ev = evaluate(pairs, golden, candidate);
    if (winner === null || cmpScore(ev.score, winner.score) > 0) {
      winner = { pairs, comparison: ev.comparison, score: ev.score };
    }
  }
  // joint always contains at least the empty matching.
  return winner as Scored;
}

function cmpScore(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// ── Pin-label translation + connectivity scoring ──

type TokenStyle = "numeric" | "named" | "mixed" | "empty";

function tokenStyle(tokens: Set<string>): TokenStyle {
  if (tokens.size === 0) return "empty";
  let allNum = true;
  let allName = true;
  for (const t of tokens) {
    if (/^\d+$/.test(t)) allName = false;
    else allNum = false;
  }
  if (allNum) return "numeric";
  if (allName) return "named";
  return "mixed";
}

function pinsOf(circuit: CanonicalCircuit): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const net of circuit.nets) {
    for (const member of net.members) {
      const dot = member.indexOf(".");
      const id = member.slice(0, dot);
      const token = member.slice(dot + 1);
      const set = m.get(id) ?? new Set<string>();
      set.add(token);
      m.set(id, set);
    }
  }
  return m;
}

interface MatchInfo {
  candidateId: string;
  granular: boolean; // collapse pins to "<id>.*"
  pinMap: Map<string, string>; // golden token -> candidate token (resolvable only)
}

const SENTINEL = "⊥"; // ⊥ prefix marks an untranslatable label

interface LabeledPair {
  key: string;
  net: string;
  a: string; // original member id.pin
  b: string;
}

function labeledPairs(
  circuit: CanonicalCircuit,
  labelOf: (member: string) => string,
): LabeledPair[] {
  const out: LabeledPair[] = [];
  for (const net of circuit.nets) {
    const members = net.members;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const la = labelOf(members[i]);
        const lb = labelOf(members[j]);
        if (la === lb) continue; // collapsed self-pair
        const key = [la, lb].sort().join(" ");
        out.push({ key, net: net.name, a: members[i], b: members[j] });
      }
    }
  }
  return out;
}

function evaluate(
  pairs: Pair[],
  golden: CanonicalCircuit,
  candidate: CanonicalCircuit,
): { comparison: CircuitComparison; score: [number, number, number] } {
  const matchG2C = new Map<string, string>();
  const matchC2G = new Map<string, string>();
  for (const [g, c] of pairs) {
    matchG2C.set(g, c);
    matchC2G.set(c, g);
  }

  const pinsG = pinsOf(golden);
  const pinsC = pinsOf(candidate);
  const goldenComp = new Map(golden.components.map((c) => [c.id, c]));
  const candidateComp = new Map(candidate.components.map((c) => [c.id, c]));

  // Per matched pair: decide pin-mapping mode.
  const info = new Map<string, MatchInfo>();
  for (const [g, c] of pairs) {
    const gTokens = pinsG.get(g) ?? new Set<string>();
    const cTokens = pinsC.get(c) ?? new Set<string>();
    const sg = tokenStyle(gTokens);
    const sc = tokenStyle(cTokens);
    const pinMap = new Map<string, string>();
    let granular = true;
    if (sg === "numeric" && sc === "numeric") {
      granular = false;
      for (const t of gTokens) if (cTokens.has(t)) pinMap.set(t, t);
    } else if (sg === "named" && sc === "named") {
      granular = false;
      const lowerC = new Map<string, string>();
      for (const t of cTokens) lowerC.set(t.toLowerCase(), t);
      for (const t of gTokens) {
        const q = lowerC.get(t.toLowerCase());
        if (q !== undefined) pinMap.set(t, q);
      }
    }
    info.set(g, { candidateId: c, granular, pinMap });
  }

  const splitMember = (member: string): [string, string] => {
    const dot = member.indexOf(".");
    return [member.slice(0, dot), member.slice(dot + 1)];
  };

  const goldenLabel = (member: string): string => {
    const [id, token] = splitMember(member);
    const mi = info.get(id);
    if (mi === undefined) return `${SENTINEL}ug:${member}`;
    if (mi.granular) return `${mi.candidateId}.*`;
    const q = mi.pinMap.get(token);
    if (q === undefined) return `${SENTINEL}g:${member}`;
    return `${mi.candidateId}.${q}`;
  };

  const candidateLabel = (member: string): string => {
    const [id, token] = splitMember(member);
    const g = matchC2G.get(id);
    if (g === undefined) return `${id}.${token}`; // unmatched candidate keeps its own id
    const mi = info.get(g);
    if (mi?.granular) return `${id}.*`;
    return `${id}.${token}`;
  };

  const goldenPairs = labeledPairs(golden, goldenLabel);
  const candidatePairs = labeledPairs(candidate, candidateLabel);
  const goldenKeys = new Set(goldenPairs.map((p) => p.key));
  const candidateKeys = new Set(candidatePairs.map((p) => p.key));

  let tp = 0;
  for (const k of goldenKeys) if (candidateKeys.has(k)) tp++;

  const precision = candidateKeys.size === 0 ? 1 : tp / candidateKeys.size;
  const recall = goldenKeys.size === 0 ? 1 : tp / goldenKeys.size;
  const connectionF1 =
    goldenKeys.size === 0 && candidateKeys.size === 0
      ? 1
      : precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);

  // Missing connections, grouped per golden net.
  const missingByNet = new Map<string, Set<string>>();
  for (const p of goldenPairs) {
    if (!candidateKeys.has(p.key)) {
      const set = missingByNet.get(p.net) ?? new Set<string>();
      set.add(p.a);
      set.add(p.b);
      missingByNet.set(p.net, set);
    }
  }
  const missingConnections = [...missingByNet.entries()].map(([net, pins]) => ({
    net,
    pins: [...pins].sort(),
  }));

  // Extra connections, grouped per candidate net; also track extras among
  // matched components (topology-relevant).
  const extraByNet = new Map<string, Set<string>>();
  let extraAmongMatched = 0;
  for (const p of candidatePairs) {
    if (!goldenKeys.has(p.key)) {
      const set = extraByNet.get(p.net) ?? new Set<string>();
      set.add(p.a);
      set.add(p.b);
      extraByNet.set(p.net, set);
      const [ida] = splitMember(p.a);
      const [idb] = splitMember(p.b);
      if (matchC2G.has(ida) && matchC2G.has(idb)) extraAmongMatched++;
    }
  }
  const extraConnections = [...extraByNet.entries()].map(([net, pins]) => ({
    net,
    pins: [...pins].sort(),
  }));

  // Net exactness: golden net fully reproduced (member sets equal in candidate
  // label space, no untranslatable members).
  const candidateNetSigs = new Set<string>();
  for (const net of candidate.nets) {
    const sig = [...new Set(net.members.map(candidateLabel))].sort().join(" ");
    candidateNetSigs.add(sig);
  }
  let exactNets = 0;
  for (const net of golden.nets) {
    const labels = net.members.map(goldenLabel);
    if (labels.some((l) => l.startsWith(SENTINEL))) continue;
    const sig = [...new Set(labels)].sort().join(" ");
    if (candidateNetSigs.has(sig)) exactNets++;
  }
  const netExactness = golden.nets.length === 0 ? 1 : exactNets / golden.nets.length;

  // Value comparison over matched pairs.
  const valueMismatches: CircuitComparison["valueMismatches"] = [];
  let valueComparablePairs = 0;
  let valueEqualPairs = 0;
  for (const [g, c] of pairs) {
    const gv = goldenComp.get(g)?.value;
    const cv = candidateComp.get(c)?.value;
    const cmp = valueComparable(gv, cv);
    if (cmp === "incomparable") continue;
    valueComparablePairs++;
    if (cmp === "equal") valueEqualPairs++;
    else valueMismatches.push({ goldenId: g, candidateId: c, goldenValue: gv, candidateValue: cv });
  }
  const valueAccuracy = valueComparablePairs === 0 ? 1 : valueEqualPairs / valueComparablePairs;

  const matchedG = new Set(pairs.map(([g]) => g));
  const matchedC = new Set(pairs.map(([, c]) => c));
  const unmatchedGolden = golden.components.map((c) => c.id).filter((id) => !matchedG.has(id));
  const unmatchedCandidate = candidate.components
    .map((c) => c.id)
    .filter((id) => !matchedC.has(id));

  const componentRecall =
    golden.components.length === 0 ? 1 : pairs.length / golden.components.length;
  const componentPrecision =
    candidate.components.length === 0 ? 1 : pairs.length / candidate.components.length;

  const topologyPass =
    netExactness === 1 &&
    extraAmongMatched === 0 &&
    unmatchedGolden.length === 0 &&
    unmatchedCandidate.length === 0;

  const comparison: CircuitComparison = {
    matching: pairs.map(([goldenId, candidateId]) => ({ goldenId, candidateId })),
    unmatchedGolden,
    unmatchedCandidate,
    valueMismatches,
    missingConnections,
    extraConnections,
    metrics: {
      componentRecall,
      componentPrecision,
      valueAccuracy,
      connectionF1,
      netExactness,
      topologyPass,
    },
  };

  return { comparison, score: [tp, valueEqualPairs, valueComparablePairs] };
}

/** Compare a golden canonical circuit against a candidate. */
export function compareCircuits(
  golden: CanonicalCircuit,
  candidate: CanonicalCircuit,
): CircuitComparison {
  return best(golden, candidate).comparison;
}
