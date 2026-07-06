import { describe, expect, test } from "bun:test";
import { compileRegex, type GoldenQuery, scoreSearch } from "./score.js";
import type { RecordedHit } from "./transport.js";

function hit(lcsc: string, p: Partial<RecordedHit> = {}): RecordedHit {
  return {
    lcsc,
    mpn: p.mpn ?? "MPN",
    manufacturer: p.manufacturer ?? "M",
    description: p.description ?? "desc",
    package: p.package ?? "0402",
    stock: p.stock ?? 1000,
    unit_price_usd: p.unit_price_usd ?? 0.01,
    library_type: p.library_type ?? "basic",
    has_footprint: p.has_footprint ?? true,
    has_symbol: p.has_symbol ?? true,
  };
}

function query(p: Partial<GoldenQuery>): GoldenQuery {
  return {
    id: "q",
    query: "q",
    anyOf: [],
    predicates: {},
    forbidden: [],
    ...p,
  };
}

describe("compileRegex", () => {
  test("translates a leading (?i) inline flag to the i flag", () => {
    const re = compileRegex("(?i)10\\s*uf");
    expect(re.flags).toBe("i");
    expect(re.test("10uF ±20%")).toBe(true);
  });
  test("plain pattern compiles unchanged", () => {
    expect(compileRegex("abc").test("xabcy")).toBe(true);
  });
});

describe("scoreSearch", () => {
  test("any-of id at rank 1 is hit@1 with MRR 1", () => {
    const s = scoreSearch(query({ anyOf: ["C1"] }), [hit("C1"), hit("C2")]);
    expect(s.hit1).toBe(true);
    expect(s.hit5).toBe(true);
    expect(s.mrr).toBe(1);
  });

  test("any-of id at rank 3 is hit@5 not hit@1, MRR 1/3", () => {
    const s = scoreSearch(query({ anyOf: ["C9"] }), [hit("C1"), hit("C2"), hit("C9")]);
    expect(s.hit1).toBe(false);
    expect(s.hit5).toBe(true);
    expect(s.mrr).toBeCloseTo(1 / 3);
    expect(s.matchedRank).toBe(3);
  });

  test("no any-of hit → MRR 0", () => {
    const s = scoreSearch(query({ anyOf: ["C9"] }), [hit("C1"), hit("C2")]);
    expect(s.matchedRank).toBeNull();
    expect(s.mrr).toBe(0);
  });

  test("predicates evaluated against the top hit", () => {
    const q = query({
      anyOf: ["C1"],
      predicates: { packageEquals: "SOT-23", descriptionRegex: "(?i)ldo" },
    });
    const s = scoreSearch(q, [hit("C1", { package: "SOT-23", description: "3.3V LDO" })]);
    expect(s.predicatesTotal).toBe(2);
    expect(s.predicatePassRate).toBe(1);
    const bad = scoreSearch(q, [hit("C1", { package: "0402", description: "MLCC" })]);
    expect(bad.predicatePassRate).toBe(0);
  });

  test("a forbidden id anywhere in results halves the headline", () => {
    const q = query({ anyOf: ["C1"], forbidden: ["C666"] });
    const clean = scoreSearch(q, [hit("C1")]);
    const dirty = scoreSearch(q, [hit("C1"), hit("C666")]);
    expect(clean.forbiddenHit).toBe(false);
    expect(dirty.forbiddenHit).toBe(true);
    expect(dirty.headline).toBeCloseTo(Math.max(0, clean.headline - 0.5));
  });
});
