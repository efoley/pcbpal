# JLCPCB Parts Database — Research Notes

## Source: kicad-jlcpcb-tools plugin

The [kicad-jlcpcb-tools](https://github.com/bouni/kicad-jlcpcb-tools) plugin
publishes pre-built SQLite FTS5 databases to GitHub Pages via a nightly
GitHub Action.

## Database variants

| Variant | Filename | Chunk sentinel | Filter |
|---------|----------|----------------|--------|
| Basic + preferred parts | `basic-parts-fts5.db` | `chunk_num_basic_parts_fts5.txt` | `basic = 1 OR preferred = 1` |
| All parts | `parts-fts5.db` | `chunk_num_fts5.txt` | everything |
| Current (non-obsolete) | `current-parts-fts5.db` | `chunk_num_current_parts_fts5.txt` | excludes long-out-of-stock |

The **basic-parts** variant is 1 chunk (~80MB compressed), while the full DB
is 11 chunks (~880MB compressed). For JLCPCB assembly, basic/preferred is the
useful subset — lower fees and guaranteed stock.

## Download protocol

Base URL: `https://bouni.github.io/kicad-jlcpcb-tools/`

1. Fetch `{base_url}/chunk_num_basic_parts_fts5.txt` → single integer (chunk count)
2. Download chunks: `{base_url}/basic-parts-fts5.db.001`, `.002`, etc.
3. Concatenate all chunks into one file — this is a **zip archive** (ZIP_DEFLATED)
4. Decompress the zip to get the SQLite DB

Chunks are numbered with 3-digit padding (`.001`, `.002`). Max chunk size is 80MB.

## Database schema

```sql
-- Main search table (FTS5 with trigram tokenization for substring matching)
CREATE VIRTUAL TABLE parts USING fts5(
  'LCSC Part',
  'First Category',
  'Second Category',
  'MFR.Part',
  'Package',
  'Solder Joint' UNINDEXED,
  'Manufacturer',
  'Library Type',       -- "Basic" or "Extended"
  'Description',
  'Datasheet' UNINDEXED,
  'Price' UNINDEXED,    -- stored as string
  'Stock' UNINDEXED,    -- stored as string
  tokenize="trigram"
);

-- Footprint-to-part mapping
CREATE TABLE mapping (
  footprint TEXT,
  value TEXT,
  LCSC TEXT
);

-- Database metadata
CREATE TABLE meta (
  filename TEXT,
  size TEXT,
  partcount TEXT,
  date TEXT,
  last_update TEXT
);

-- Category index
CREATE TABLE categories (
  'First Category' TEXT,
  'Second Category' TEXT
);
```

## Upstream cache database (cache.sqlite3)

The nightly job first builds/updates a cache DB from the JLCSC API, then
converts it to the FTS5 format above.

```sql
CREATE TABLE components (
  lcsc INTEGER PRIMARY KEY,
  category_id INTEGER,
  manufacturer_id INTEGER,
  mfr TEXT,
  package TEXT,
  description TEXT,
  datasheet TEXT,
  stock TEXT,          -- JSON
  price TEXT,          -- JSON
  basic INTEGER,       -- 0 or 1
  preferred INTEGER,   -- 0 or 1
  joints INTEGER,
  flag INTEGER,
  last_update TEXT,
  last_on_stock TEXT,
  extra TEXT           -- JSON
);

CREATE TABLE manufacturers (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE categories (id INTEGER PRIMARY KEY, category TEXT, subcategory TEXT);
```

The cache is updated by crawling the JLCSC API category by category. Components
not seen in 7 days are marked out-of-stock; records older than 1 year are pruned.

## Per-project plugin database (project.db)

Each KiCad project using the plugin has a small `jlcpcb/project.db` (~12KB):

```sql
CREATE TABLE part_info (
  reference TEXT,           -- KiCad ref designator (e.g. "R31")
  value TEXT,               -- component value (e.g. "10k")
  footprint TEXT,           -- KiCad footprint name (e.g. "R_0402_1005Metric")
  lcsc TEXT,                -- LCSC part number (e.g. "C25744")
  stock NUMERIC,
  exclude_from_bom NUMERIC,
  exclude_from_pos NUMERIC
);
```

This is the BOM assignment table — maps schematic refs to LCSC parts.

## Mapping FTS5 columns to pcbpal's LcscSearchHit

| FTS5 column | LcscSearchHit field | Notes |
|-------------|---------------------|-------|
| `LCSC Part` | `lcsc` | |
| `MFR.Part` | `mpn` | |
| `Manufacturer` | `manufacturer` | |
| `Description` | `description` | |
| `Package` | `package` | |
| `Stock` | `stock` | parse as number |
| `Price` | `unit_price_usd` | parse as number |
| `Library Type` | `library_type` | "Basic" → "basic", "Extended" → "extended" |
| `Datasheet` | `datasheet_url` | |
| `First Category` / `Second Category` | — | not in current type, useful for filtering |
| — | `url` | construct: `https://jlcpcb.com/partdetail/{lcsc}` |

## Implementation plan for pcbpal

1. `pcbpal parts update` — download basic-parts-fts5.db to `~/.pcbpal/parts.db`
   (global, not per-project). Decompress zip via `unzip` or `fflate` npm package.
2. `pcbpal parts search <query>` — FTS5 MATCH query against local DB. Map results
   to `LcscSearchHit` for consistent output.
3. Add `--offline` flag to existing `pcbpal search` to use local DB instead of API.
4. Add parts DB check to `pcbpal doctor`.
5. Store metadata in `~/.pcbpal/parts-meta.json` (download timestamp, row count).
   Warn if DB is older than 30 days.
