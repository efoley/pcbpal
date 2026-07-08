# Datasheet Understanding: Extraction Pipeline + Eval Harness

Status: proposal (2026-07)

This doc expands `notes/datasheet_schematic_ocr.md` into a full design for
(a) a `pcbpal datasheet` command family that extracts specs, pin tables, and
application circuits from datasheet PDFs using LLM sub-agents, and (b) an
eval harness that measures whether those extractions are *faithful* — no
hallucinated values, no dropped connections — so we can iterate on prompts,
decomposition strategy, and models with a regression signal instead of vibes.

---

## 1. Why this matters

Datasheets are the ground truth for everything pcbpal cares about:

- **BOM correctness** — is the selected part actually rated for the rail
  voltage / temperature / current in `constraints.parameters`?
- **Schematic review** — the datasheet's recommended application circuit is
  the reference to diff the user's schematic against ("you're missing the
  10µF output cap the LDO needs for stability").
- **Pin mapping** — `firmware-datasheet` derives pin purposes from the
  netlist, but the *datasheet's* pin table is what says which pins are
  5V-tolerant, which are input-only, which alternate functions exist.

An LLM that silently misreads "2.2µH" as "2.2mH" or drops the feedback
divider from an extracted buck converter circuit is worse than no extraction
at all, because downstream review will confidently bless a broken design.
Hence: structured extraction with provenance, verification passes, and evals
that specifically punish hallucination and omission.

---

## 2. Architecture: where the LLM lives

pcbpal's standing rule (see `cli_human_vs_llm.md`, `pcbpal-design.md` §"pcbpal
as a tool for Claude Code") is that **pcbpal does deterministic plumbing and
validation; the LLM agent orchestrates**. Datasheet understanding fits that
split cleanly:

```
                    deterministic (pcbpal)                LLM sub-agents
                    ──────────────────────                ──────────────
fetch PDF           datasheet fetch  ────────┐
render pages to PNG datasheet pages  ────────┤
assemble task pkg   datasheet extract        │
                      --prepare      ────────┼──▶  extractor agents fill
                                             │     fixed JSON schemas
validate output     datasheet validate ◀─────┘     (one agent per facet)
cross-check         datasheet validate                    │
diff vs schematic   datasheet diff   ◀────────────────────┘
```

Two consumption modes:

1. **Agent-driven (primary).** Claude Code runs `pcbpal datasheet extract
   --prepare --json`, gets a task package (page PNGs + JSON schema +
   instructions), spawns sub-agents to fill the schemas, then runs
   `pcbpal datasheet validate` on the result. This is the same pattern as
   `review --prepare-only`. The CLAUDE.md template documents the workflow so
   any agent can drive it.

2. **Direct (optional, later).** `pcbpal datasheet extract` without
   `--prepare` calls the configured LLM API itself (`[llm]` in pcbpal.toml)
   for terminal users who aren't inside an agent. Same core logic; the API
   call lives in a new `src/services/llm.ts`. The eval harness (§6) needs
   this service anyway, so the marginal cost is small — but it ships second.

### Sub-agent decomposition

One giant "read this 400-page datasheet" prompt is the failure mode. Instead,
one focused sub-agent per *facet*, each receiving only the relevant pages:

| Agent              | Input pages                        | Output schema        |
|--------------------|------------------------------------|----------------------|
| `page-indexer`     | TOC + skim of full PDF (text layer)| `DatasheetIndex`     |
| `pin-table`        | pinout pages                       | `PinTable`           |
| `electrical-specs` | abs-max + recommended + elec-char  | `SpecTable`          |
| `app-circuit`      | one figure (cropped region)        | `ReferenceCircuit`   |
| `verifier`         | same pages + one agent's output    | `VerificationReport` |

The `page-indexer` runs first (cheap, text-only where the PDF has a text
layer) and locates which pages hold which facets, so the vision agents get
3–8 page images, not 400. Its output is also independently useful
(`pcbpal datasheet pages --list`).

---

## 3. Extraction schemas (Zod, in `src/schemas/datasheet.ts`)

Design rules baked into the schemas:

- **Every fact carries provenance** — page number plus table/figure/section
  label. Un-cited facts fail validation. Provenance is what makes both the
  verifier pass and human spot-checks cheap.
- **Numbers are structured, never strings** — `{ min?, typ?, max?, unit,
  conditions? }`, deliberately congruent with `PartConstraints.parameters`
  in `bom.ts` so extracted specs can flow into BOM constraints.
- **Explicit `not_found` beats silence** — agents must report facets they
  looked for and couldn't find, so evals can distinguish omission (bad) from
  honest absence (fine).

```typescript
export const Provenance = z.object({
  page: z.number().int().positive(),
  label: z.string(),            // "Table 5", "Figure 12", "§6.3"
  note: z.string().optional(),  // free-text locator, e.g. "third row"
});

export const SpecValue = z.object({
  min: z.number().optional(),
  typ: z.number().optional(),
  max: z.number().optional(),
  unit: z.string(),             // normalized: "V", "mA", "µH", "MHz", "°C"
  conditions: z.string().optional(),  // "VIN=5V, IOUT=1A, TA=25°C"
});

export const SpecItem = z.object({
  parameter: z.string(),        // "Input voltage", "Quiescent current"
  symbol: z.string().optional(),// "VIN", "IQ"
  value: SpecValue,
  provenance: Provenance,
  confidence: z.enum(["high", "medium", "low"]),
});

export const SpecTable = z.object({
  device: z.string(),                    // MPN as printed on the datasheet
  section: z.enum(["absolute_maximum", "recommended_operating",
                   "electrical_characteristics", "thermal", "other"]),
  items: z.array(SpecItem),
  not_found: z.array(z.string()).default([]),  // facets searched but absent
});

export const PinEntry = z.object({
  number: z.string(),           // "1", "A3" (BGA), "EP" (exposed pad)
  name: z.string(),             // "PA5", "VOUT", "NC"
  type: z.enum(["power_in", "power_out", "input", "output", "bidirectional",
                "analog", "passive", "nc", "other"]),
  description: z.string().optional(),
  provenance: Provenance,
});

export const PinTable = z.object({
  device: z.string(),
  package: z.string(),          // "SOT-23-5", "QFN-32"
  pin_count: z.number().int().positive(),
  pins: z.array(PinEntry),
});

// Reference/application circuit — the hard one. Component-centric pin
// connections, NOT freeform net descriptions: the agent enumerates parts
// first, then states where each pin of each part goes. Nets are derived,
// which forces locality and makes contradictions detectable.
export const RefCircuitComponent = z.object({
  designator: z.string(),       // as printed in the figure: "C1", "R2", "L1"
  kind: z.enum(["resistor", "capacitor", "inductor", "diode", "led",
                "transistor", "ic", "crystal", "connector", "ferrite",
                "other"]),
  value: z.string().optional(),      // "10µF", "100kΩ", as printed
  part: z.string().optional(),       // MPN if the figure names one
  pins: z.array(z.object({
    pin: z.string(),                 // "1", "2", "A", "K", "GATE"
    connects_to: z.array(z.string()),// "C1.2", "GND", "VIN" — pin refs or
                                     // named rails appearing in the figure
  })),
});

export const ReferenceCircuit = z.object({
  device: z.string(),
  title: z.string(),                 // figure caption
  provenance: Provenance,
  components: z.array(RefCircuitComponent),
  rails: z.array(z.string()),        // named nets: "VIN", "VOUT", "GND"
  notes: z.array(z.string()).default([]),  // "C1 must be X7R", "L1 ≥ 2.2µH"
  confidence: z.enum(["high", "medium", "low"]),
});
```

`datasheet validate` derives the net list from `connects_to` and rejects
contradictions (A says it connects to B, B doesn't mention A), dangling pins
not marked NC, and pin references to undeclared components.

---

## 4. Faithfulness mechanisms

Ranked by cost; the first three are table stakes, the rest are dials the
evals will tell us whether we need.

1. **Schema-forced output with provenance** (free). Structured output means
   no prose to mis-parse; required provenance means every claim is checkable
   and the agent can't launder uncertainty into fluent text.

2. **Deterministic cross-checks in `datasheet validate`** (free, no LLM):
   - Net derivation consistency for circuits (above).
   - `pins.length === pin_count`, no duplicate pin numbers, pin count
     plausible for the named package (SOT-23-5 ⇒ 5).
   - Unit sanity: unit string parses against a whitelist per parameter class
     (a voltage spec with unit "A" is rejected); `min ≤ typ ≤ max`.
   - **Cross-source check against LCSC**: `lcsc.ts` already returns
     parametric attributes for a part. Where LCSC and the extraction cover
     the same parameter (package, VIN range, output voltage), disagreement
     flags the field. Two independent sources agreeing is strong evidence;
     this is the cheapest "second witness" we have.

3. **Independent verifier pass** (1 extra call per facet). A separate
   sub-agent gets the same page images plus the extractor's output and a
   *skeptical* prompt: for each item, re-read the cited location and mark
   `confirmed | wrong | not_at_cited_location`. The verifier never sees the
   extractor's reasoning, only its claims. Fields the verifier rejects are
   dropped or downgraded to `low` confidence — for our use case a flagged
   hole is fine, a confident lie is not.

4. **Self-consistency voting** (N× cost, use for circuits only). Run the
   `app-circuit` extractor 3× at temperature > 0, derive each netlist,
   keep connections present in ≥2/3 runs, flag the rest. Circuit topology is
   where single-pass vision is weakest, and connection-level voting is
   mechanical once nets are derived. Evals decide whether N=3 earns its cost.

5. **Enumerate-then-trace prompting** (prompt design, free). The app-circuit
   prompt forces phases: (1) list every component symbol and printed value;
   (2) for each component, each pin, name what the wire touches; (3) list
   junction dots explicitly. LLMs fail at gestalt "describe this circuit" but
   are much better at exhaustive local reads — the schema shape (§3) is
   designed to make the local read the only way to answer.

6. **Figure cropping** (plumbing). `datasheet pages --crop` renders a
   figure's bounding box at higher DPI instead of a full page. Small text on
   dense schematic figures is the dominant vision failure; resolution is the
   cheapest fix. The page-indexer reports figure bounding boxes when the PDF
   text layer allows it.

---

## 5. CLI surface

```
pcbpal datasheet fetch [--lcsc C123456 | --url <u> | --bom-id <id>]
    Download to .pcbpal/datasheets/<sha256-prefix>-<mpn>.pdf, record
    source URL + checksum. Idempotent; cache hit prints existing path.

pcbpal datasheet pages <pdf|part> [--pages 3,7-9] [--dpi 200] [--crop auto]
    Render pages to PNGs in .pcbpal/datasheets/pages/. --list prints the
    page index (from page-indexer output if present, else PDF outline).

pcbpal datasheet extract <part> --facet specs|pins|circuit [--prepare]
    --prepare: write task package (PNGs, JSON schema, instructions) to
    .pcbpal/datasheets/tasks/<part>-<facet>/ and print its manifest.
    Without --prepare (later): run the configured LLM directly.

pcbpal datasheet validate <extraction.json> [--against-lcsc]
    Zod-validate + deterministic cross-checks (§4.2). Exit 2 on failures,
    structured findings in JSON.

pcbpal datasheet diff <circuit.json> [--refs U1,C3,C4,L1,R1,R2]
    Compare extracted reference circuit against the project's KiCad netlist
    (via services/netlist.ts), scoped to the given refs (or auto-matched by
    the target IC's MPN). Reports missing/extra connections, value
    mismatches with tolerance awareness (10µF vs 10uF vs 0.00001F equal;
    10µF vs 22µF flagged as "different value, same role").
```

PDF plumbing: render via `pdftoppm`/`pdftotext` (poppler-utils — small,
ubiquitous; `mutool` fallback), same pattern as the planned `rsvg-convert`
dependency. `pcbpal doctor` checks for them.

Extracted results are cached as
`.pcbpal/datasheets/extracted/<mpn>-<facet>.json` with the PDF checksum +
extractor version inside, so `bom check` / `review` can consume them without
re-running agents, and staleness is detectable.

### Downstream integrations (the payoff)

- `bom check --against-datasheet`: verify each BOM entry's
  `constraints.parameters` against the extracted spec table.
- `review schematic`: attach extracted reference circuits + `datasheet diff`
  results to `context.json`, so review says "differs from datasheet Fig. 12:
  missing C_ff across R_FB1" instead of guessing from pixels.
- `firmware-datasheet`: merge extracted pin-table metadata (5V-tolerance,
  alternate functions) into the pin map.

---

## 6. Eval harness

The reason this doc exists. Extraction quality is invisible without ground
truth, and prompt/model changes silently regress. The harness lives in
`evals/` (outside `src/` — it is not shipped, and unlike pcbpal core it IS
allowed to call LLM APIs).

```
evals/
├── datasheets/
│   ├── manifest.json            # part list: mpn, lcsc id, pdf url, sha256
│   ├── golden/
│   │   ├── ams1117-3.3/
│   │   │   ├── specs.json       # hand-verified SpecTable
│   │   │   ├── pins.json        # hand-verified PinTable
│   │   │   └── circuit-fig12.json  # hand-verified ReferenceCircuit
│   │   └── .../
│   └── cache/                   # fetched PDFs + rendered PNGs (gitignored)
├── runners/
│   ├── run-extraction.ts        # matrix: parts × facets × strategies × models
│   └── strategies.ts            # single-pass / +verifier / +voting / +crop
├── scoring/
│   ├── score-specs.ts
│   ├── score-pins.ts
│   ├── score-circuit.ts         # netlist graph comparison
│   └── normalize.ts             # units, value strings, net canonicalization
├── results/                     # timestamped run outputs (gitignored)
│   └── baseline.json            # committed: last accepted scores per case
└── report.ts                    # markdown/JSON summary, diff vs baseline
```

**PDFs are not committed** (redistribution is murky) — the manifest pins
URL + sha256 and the runner fetches into `cache/`. Golden JSON is ours and
is committed. If a vendor URL rots, the checksum tells us the golden data
no longer matches whatever the new PDF says.

### Golden dataset (v1: ~12 parts, deliberately spread)

| Category   | Part (example)      | Why it's in the set                          |
|------------|---------------------|----------------------------------------------|
| LDO        | AMS1117-3.3         | trivial circuit (2 caps); floor check         |
| LDO        | TLV75733            | modern datasheet layout, tiny package         |
| Buck       | TPS62130 / MP2315   | feedback divider + inductor — topology test   |
| Boost      | MT3608              | low-quality Chinese datasheet — robustness    |
| MCU        | STM32C011 / PY32F002| big pin table, multi-package, decoupling fig  |
| USB-PD     | CH224K              | Chinese+English mixed datasheet               |
| Sensor     | BME280              | dense spec tables, conditions matter          |
| Op-amp     | LM358               | scanned-era PDF, poor text layer              |
| RF module  | ESP32-C3-MINI-1     | module pinout, keepout notes                  |
| Crystal    | 32.768kHz cylinder  | spec-only (no circuit) — tests `not_found`    |
| MOSFET     | AO3400              | SOA/thermal tables, graph-adjacent data       |
| Multi-fig  | TPS54331            | several app circuits — figure disambiguation  |

Each part gets golden files only for facets we hand-verify (start: specs for
all 12, pins for 6, circuits for 8). Authoring aid: run the extractor, then
*correct* its output against the PDF by hand — correcting is ~5× faster than
transcribing, and every correction made is itself a catalogued failure mode.
Rule: every golden file is verified against the PDF by a human before commit;
never commit uncorrected model output as truth.

### Metrics

**Specs / pins (field-level):** match golden items to extracted items by
normalized `(parameter|symbol)` key, then per matched item compare
`(min, typ, max, unit)` after unit normalization (µ/u, 1000mA = 1A, °C/C).

- `recall` — golden items extracted (omission rate = 1 − recall)
- `precision` — extracted items that exist in golden
- **`hallucination_rate`** — extracted items with *wrong values* or citing
  locations where the fact isn't. Tracked separately from precision because
  a fabricated-but-plausible max voltage is the single worst outcome; the
  headline score weights it ~4× an omission.
- `provenance_accuracy` — cited page actually contains the fact (checkable
  cheaply against golden provenance)
- `calibration` — accuracy split by claimed confidence; `high` items should
  be >98% correct or the confidence field is decoration

**Circuits (graph-level):** canonicalize both netlists — designators are
arbitrary, so match components by `(kind, normalized value, pin count)` and
compare *connectivity*, not names:

- `component_recall / precision` — parts found / not invented
- `value_accuracy` — matched components with correct printed value
- **`connection_F1`** — derive pin-pin adjacency within each net for both
  graphs; score pair overlap under the component matching that maximizes
  agreement (small circuits: exhaustive matching is fine ≤ ~15 parts;
  larger: greedy by kind+value, which is stable in practice)
- `net_exactness` — fraction of golden nets whose full member set is
  exactly reproduced (stricter than pairwise F1; a single wrong feedback
  connection tanks this, as it should)
- `topology_pass` — boolean: derived netlists are graph-isomorphic under
  component matching. The headline for "can we trust `datasheet diff`".

**Harness outputs:** per-case scores, aggregates per (facet × strategy ×
model), cost/latency per case, and a diff vs `baseline.json`. A committed
baseline turns "did my prompt change help" into a CI-able answer; a
regression on `hallucination_rate` or `topology_pass` fails the run.

### Strategy matrix (what the evals decide)

The dials from §4, run as controlled comparisons:

1. single-pass extractor (floor)
2. \+ deterministic validate-and-retry (agent gets validator findings once)
3. \+ verifier pass
4. \+ self-consistency ×3 (circuits only)
5. \+ figure cropping at 2× DPI
6. model matrix: current Claude models vs a small/cheap tier — is the cheap
   model + verifier better than the big model single-pass per dollar?

Hypotheses to confirm/kill: verifier mainly buys hallucination reduction on
specs; voting mainly buys `connection_F1` on circuits; cropping dominates
everything for dense figures; `not_found` honesty degrades sharply with
page-count overload (which justifies the page-indexer's existence).

---

## 7. Implementation plan

Ordered so each step is independently useful; 1–4 need no LLM API key in
pcbpal itself (agent-driven mode only).

1. **Schemas + validate** — `src/schemas/datasheet.ts`, net derivation,
   deterministic checks, `datasheet validate`. Pure logic, fully unit-testable
   without any LLM. *This is where faithfulness enforcement lives; everything
   else routes through it.*
2. **PDF plumbing** — `datasheet fetch` / `pages` (poppler), page-index
   heuristics from the PDF text layer/outline; `doctor` checks.
3. **Task packages** — `datasheet extract --prepare`, CLAUDE.md template
   section teaching the agent the extract → validate → retry loop.
4. **`datasheet diff`** — netlist canonicalization + comparison against
   `services/netlist.ts` output. The comparison code is shared with
   `score-circuit.ts`, so building it here funds the eval harness too.
5. **Eval harness v1** — manifest + 4 parts (AMS1117, MP2315, CH224K,
   BME280), golden specs+circuits, `run-extraction.ts` calling the Anthropic
   API directly, scoring + report + baseline.
6. **Grow the set, run the matrix** — 12 parts, strategies 1–5, pick the
   default strategy per facet from data; wire the winner into
   `datasheet extract` (direct mode) via `src/services/llm.ts`.
7. **Downstream** — `bom check --against-datasheet`, review-context
   attachment, `firmware-datasheet` pin enrichment.

---

## 8. Other eval opportunities (beyond datasheets, brief)

The harness skeleton (golden JSON + scorer + baseline diff) generalizes:

- **Search relevance** — golden query→expected-LCSC-part sets; catches LCSC
  API drift and ranking regressions. No LLM needed.
- **`review schematic` end-to-end** — seeded-defect KiCad projects (missing
  decoupling cap, swapped feedback resistors, floating enable); score
  whether an agent driving `review --prepare-only` context finds the seeded
  defect. Directly measures the value of adding the text netlist
  (`notes/schematic_netlist_for_review.md`) to the context package.
- **`bom sync` matching** — golden schematic↔BOM correspondence on fixture
  projects; deterministic, cheap, CI-able today.
- **Footprint sanity** — golden pad counts/pitches for fetched LCSC
  footprints vs `services/footprint.ts` parsing.

Seeded-defect review evals are the natural phase after datasheet evals: they
reuse the same runner and reporting, and datasheet extraction quality
directly feeds the review context they measure.
