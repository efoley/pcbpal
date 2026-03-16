import { type LcscSearchHit, lookupPart, searchComponents } from "../../services/lcsc.js";

export interface SearchOptions {
  query: string;
  supplier?: "lcsc";
  inStock?: boolean;
  maxPrice?: number;
  limit?: number;
  lcsc?: string;
}

export interface SearchResult {
  results: LcscSearchHit[];
  total: number;
  query: string;
  supplier: string;
}

export async function searchParts(opts: SearchOptions): Promise<SearchResult> {
  // Direct LCSC lookup by part number
  if (opts.lcsc) {
    const hit = await lookupPart(opts.lcsc);
    return {
      results: hit ? [hit] : [],
      total: hit ? 1 : 0,
      query: opts.lcsc,
      supplier: "lcsc",
    };
  }

  const result = await searchComponents({
    query: opts.query,
    inStock: opts.inStock,
    maxPrice: opts.maxPrice,
    limit: opts.limit,
  });

  return {
    results: result.results,
    total: result.total,
    query: result.query,
    supplier: result.supplier,
  };
}
