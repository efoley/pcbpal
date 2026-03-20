/**
 * LCSC/EasyEDA API client.
 *
 * Component search uses the JLCPCB API:
 *   POST https://jlcpcb.com/api/searchComponent/list
 *
 * Component detail (symbol/footprint data) uses the EasyEDA API:
 *   POST https://easyeda.com/api/components/search
 *   GET  https://easyeda.com/api/components/{uuid}
 *
 * These endpoints are undocumented but stable — used by the tscircuit
 * easyeda-converter package and JLCPCB's own web frontend.
 */

// ── Search types ──

export interface LcscSearchOptions {
  query: string;
  inStock?: boolean;
  maxPrice?: number;
  limit?: number;
  page?: number;
}

export interface LcscSearchHit {
  lcsc: string;
  mpn: string;
  manufacturer: string;
  description: string;
  package: string;
  stock: number;
  unit_price_usd: number | null;
  datasheet_url: string | null;
  url: string | null;
  library_type: "basic" | "extended";
  has_footprint: boolean;
  has_symbol: boolean;
}

export interface LcscSearchResult {
  results: LcscSearchHit[];
  total: number;
  query: string;
  supplier: "lcsc";
}

// ── Detail types ──

export interface LcscComponentDetail {
  lcsc: string;
  mpn: string;
  manufacturer: string;
  description: string;
  package: string;
  datasheet_url: string | null;
  stock: number;
  unit_price_usd: number | null;
  symbol: unknown | null;
  footprint: unknown | null;
}

// ── Shared headers ──

const EASYEDA_HEADERS: Record<string, string> = {
  accept: "application/json, text/javascript, */*; q=0.01",
  "x-requested-with": "XMLHttpRequest",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  origin: "https://easyeda.com",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
  referer: "https://easyeda.com/editor",
};

// ── Search via JLCPCB API ──

export async function searchComponents(opts: LcscSearchOptions): Promise<LcscSearchResult> {
  const limit = opts.limit ?? 20;
  const page = opts.page ?? 1;

  const body = {
    keyword: opts.query,
    searchSource: "search",
    componentAttributes: [],
    stockFlag: opts.inStock ? 1 : null,
    pageSize: limit,
    currentPage: page,
  };

  const res = await fetch(
    "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    throw new Error(`JLCPCB search API returned ${res.status}`);
  }

  const data = await res.json();

  if (data.code !== 200 && data.code !== 0) {
    throw new Error(`JLCPCB search API error: ${data.msg ?? "unknown error"}`);
  }

  const componentList: any[] = data.data?.componentPageInfo?.list ?? [];

  const results: LcscSearchHit[] = componentList.map((c: any) => {
    const prices = c.componentPrices ?? [];
    const lowestPrice =
      prices.length > 0
        ? Math.min(...prices.map((p: any) => parseFloat(p.productPrice) || Infinity))
        : null;

    return {
      lcsc: c.componentCode ?? "",
      mpn: c.componentModelEn ?? "",
      manufacturer: c.componentBrandEn ?? "",
      description: c.describe ?? "",
      package: c.componentSpecificationEn ?? "",
      stock: c.stockCount ?? 0,
      unit_price_usd: lowestPrice === Infinity ? null : lowestPrice,
      datasheet_url: c.dataManualUrl ?? null,
      url: c.lcscGoodsUrl ?? null,
      library_type: c.componentLibraryType === "base" ? "basic" : "extended",
      has_footprint: !!c.componentCode,
      has_symbol: !!c.componentCode,
    };
  });

  // Apply max price filter client-side
  const maxPrice = opts.maxPrice;
  const filtered = maxPrice
    ? results.filter((r) => r.unit_price_usd !== null && r.unit_price_usd <= maxPrice)
    : results;

  return {
    results: filtered,
    total: data.data?.componentPageInfo?.total ?? filtered.length,
    query: opts.query,
    supplier: "lcsc",
  };
}

// ── Component detail via EasyEDA API ──

export async function fetchComponentDetail(lcscPartNumber: string): Promise<LcscComponentDetail> {
  // Step 1: Search EasyEDA for the component UUID
  const searchBody = new URLSearchParams({
    type: "3",
    "doctype[]": "2",
    uid: "0819f05c4eef4c71ace90d822a990e87",
    returnListStyle: "classifyarr",
    wd: lcscPartNumber,
    version: "6.4.7",
  }).toString();

  const searchRes = await fetch("https://easyeda.com/api/components/search", {
    method: "POST",
    headers: EASYEDA_HEADERS,
    body: searchBody,
  });

  if (!searchRes.ok) {
    throw new Error(`EasyEDA search API returned ${searchRes.status}`);
  }

  const searchData = await searchRes.json();

  if (!searchData.success) {
    throw new Error("EasyEDA search failed");
  }

  const lcscList: any[] = searchData.result?.lists?.lcsc ?? [];
  if (lcscList.length === 0) {
    throw new Error(`Component ${lcscPartNumber} not found on EasyEDA/LCSC`);
  }

  // Find exact match or take the first result
  const bestMatch =
    lcscList.find((c: any) => c.dataStr?.head?.c_para?.["Supplier Part"] === lcscPartNumber) ??
    lcscList[0];

  const componentUUID: string = bestMatch.uuid;
  const cPara = bestMatch.dataStr?.head?.c_para ?? {};

  // Step 2: Fetch full component detail
  const detailUrl = `https://easyeda.com/api/components/${componentUUID}?version=6.4.7&uuid=${componentUUID}&datastrid=`;

  const detailRes = await fetch(detailUrl, {
    method: "GET",
    headers: {
      ...EASYEDA_HEADERS,
      referer: `https://easyeda.com/editor?uuid=${componentUUID}`,
    },
  });

  if (!detailRes.ok) {
    throw new Error(`EasyEDA component API returned ${detailRes.status}`);
  }

  const detailData = await detailRes.json();
  const result = detailData.result;

  // Extract symbol and footprint data from the component
  // The component JSON contains both schematic and PCB data
  const symbolData = result ?? null;
  const footprintData = result ?? null;

  return {
    lcsc: lcscPartNumber,
    mpn: cPara["Manufacturer Part"] ?? cPara.MPN ?? "",
    manufacturer: cPara.Manufacturer ?? "",
    description: bestMatch.title ?? "",
    package: cPara.Package ?? "",
    datasheet_url: cPara.link ?? null,
    stock: 0,
    unit_price_usd: null,
    symbol: symbolData,
    footprint: footprintData,
  };
}

// ── Lookup a single part by LCSC number via JLCPCB API ──

export async function lookupPart(lcscPartNumber: string): Promise<LcscSearchHit | null> {
  const result = await searchComponents({
    query: lcscPartNumber,
    limit: 5,
  });

  return result.results.find((r) => r.lcsc === lcscPartNumber) ?? result.results[0] ?? null;
}
