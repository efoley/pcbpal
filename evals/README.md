# pcbpal eval harnesses

Every suite lives outside `src/` (it is not shipped) and, unlike pcbpal core,
is allowed to call LLM APIs. Each is **offline-first**: it runs in CI with no
network and no API key, with any LLM/network path behind an explicit flag and a
committed offline fallback (mock transport, recordings, or dry-run synthesis).
Each suite has its own committed `baseline.json` and fails its runner (exit 1)
on a regression versus that baseline.

## Suites overview

| Suite | Measures | Offline story | Run |
|---|---|---|---|
| **datasheets** (`src/`) | Faithfulness of LLM datasheet extraction (specs/pins/circuit) — hallucination & omission rates, topology. Spec: `design-docs/datasheet_understanding_evals.md` §6. | `--dry-run` feeds each strategy the golden through `MockTransport`; live needs `poppler-utils` + `ANTHROPIC_API_KEY`. | `bun run evals -- --dry-run --strategy single-pass` |
| **bom-sync** (`bom-sync/`) | Schematic↔BOM correspondence quality of the pure `matchSchematicToBom` matcher — pair precision/recall + unmatched/orphaned/footprint-mismatch set exactness. §8. | Fully deterministic, no LLM, no network — always runs in CI. | `bun run evals:bom-sync` |
| **search** (`search/`) | LCSC search relevance for golden queries — hit@1/hit@5/MRR against any-of id sets, attribute-predicate pass rate, forbidden-hit rate. §8. | Replay of committed recordings (default); `--live` hits LCSC and records. LCSC is blocked in CI (403), so replay is the CI path; synthetic recordings score the logic offline. | `bun run evals:search` (replay) / `bun evals/search/run.ts --live` |
| **review** (`review/`, stretch) | Whether a schematic review catches a seeded defect (missing decoupling cap, swapped feedback divider) — recall over "should mention" regex criteria. §8. | Dry-run synthesizes a review satisfying the criteria (plumbing check); `--live` makes one Anthropic call over the netlist+BOM context. Live is implemented but untested in CI. | `bun run evals:review` (dry-run) / `bun evals/review/run.ts --live` |

Shared baseline/regression-gate + set helpers live in `src/shared/gate.ts`
(used by the sibling suites; the datasheet suite keeps its own `report.ts`).
Each sibling suite accepts a fresh baseline with `--accept-baseline`.

---

## Datasheet suite (`evals/src`)

Measures whether LLM datasheet extractions are **faithful** — no hallucinated
values, no dropped connections — so prompt/model/strategy changes get a
regression signal instead of vibes. Spec: `design-docs/datasheet_understanding_evals.md` §6.

It is **offline-first**: the whole pipeline runs with no network and no API key
via `--dry-run`, which feeds each strategy the golden extraction through a mock
transport. Live runs happen on a machine with `poppler-utils` and
`ANTHROPIC_API_KEY`.

## Layout

```
evals/
├── datasheets/
│   ├── manifest.json            # parts: id, mpn, lcsc, pdf_url, pdf_sha256, facets, pages hints
│   ├── golden/<part-id>/{specs,pins,circuit-<label>}.json
│   └── cache/                   # fetched PDFs + rendered PNGs (gitignored)
├── src/
│   ├── types.ts                 # Zod schemas: manifest, golden, run, baseline
│   ├── normalize.ts             # key normalization + unit-aware value equality
│   ├── score-specs.ts / score-pins.ts / score-circuit.ts
│   ├── transport.ts             # AnthropicTransport (fetch) + MockTransport
│   ├── strategies.ts            # single-pass / validate-retry / verifier / self-consistency-3
│   ├── run.ts                   # runner CLI
│   ├── report.ts                # aggregate + markdown/JSON + baseline diff
│   └── *.test.ts
├── results/                     # timestamped run outputs (gitignored except .gitkeep)
└── baseline.json                # committed accepted scores per case (starts {})
```

## Running

Offline plumbing check (no network, no key) — every case scores 1.0:

```
bun evals/src/run.ts --dry-run --strategy single-pass
# or: bun run evals -- --dry-run --strategy single-pass
```

Live run (needs poppler-utils + a key):

```
export ANTHROPIC_API_KEY=sk-ant-...
bun evals/src/run.ts \
  --parts ams1117-3.3,mp2315 \
  --facets specs,circuit \
  --strategy single-pass \
  --model claude-opus-4-8 \
  --fetch                      # download missing PDFs into datasheets/cache/
```

Flags: `--parts`, `--facets`, `--strategy`
(`single-pass|validate-retry|verifier|self-consistency-3`), `--model`,
`--max-tokens`, `--dpi`, `--dry-run`, `--fetch`, `--run-label`,
`--accept-baseline`. Progress prints to stderr, a summary table to stdout, and
full `run.json` + `report.md` land in `results/<timestamp>-<label>/`.

### Baseline & CI

`report.ts` diffs each run against `baseline.json`. A case **regresses** (runner
exits 1) when, versus baseline, its `hallucination_rate` rises > 0.01, a circuit
`topologyPass` flips true→false, or its `headline` drops > 0.05. Accept the
current scores as the new baseline with:

```
bun evals/src/run.ts --strategy single-pass --accept-baseline
```

## Metrics

- **specs**: recall, precision, `hallucination_rate` (wrong value/unit or wrong
  cited page + invented items), omission_rate, provenance_accuracy, calibration
  by confidence. Headline `= clamp(1 - (4·hallucinations + omissions)/(5·N), 0, 1)`
  — a hallucination is weighted 4× an omission.
- **pins**: coverage, name/type accuracy over matched pin numbers, extra pins.
  Headline = fraction of golden pins reproduced exactly (number+name+type).
- **circuit**: componentRecall/precision, valueAccuracy, `connectionF1`,
  netExactness, `topologyPass`, hallucinated/missed components. Headline =
  connectionF1. Scoring is a thin adapter over the shipped circuit referee
  (`src/services/refcircuit-compare.ts`) — the same code `datasheet diff` uses.

## Authoring goldens

1. Add the part to `datasheets/manifest.json` (id, mpn, lcsc, pdf_url,
   `pdf_sha256` may be `"TBD"` until first fetched, `facets`, optional `pages`
   hints per facet / `circuit-<label>`).
2. Create `datasheets/golden/<part-id>/<facet>.json` (circuits:
   `circuit-<label>.json`). Format is the pcbpal `DatasheetExtraction` envelope
   wrapped with eval metadata:

   ```json
   { "golden_version": 1, "verified": false, "verified_by": null,
     "notes": "...", "extraction": { ...DatasheetExtraction... } }
   ```

3. **`verified` MUST be false** for anything not human-checked against the PDF.
   The design-doc rule is that humans verify goldens; an agent (or a raw model
   run) may only author drafts. The runner prints a loud warning for every
   unverified golden it scores against, and reports label them `UNVERIFIED`.
   A human sets `verified: true` + `verified_by` only after diffing against the
   actual datasheet PDF.

### Golden authoring notes (circuit facet)

- Use **real IC pin names** ("FB", "SW", "VOUT"), not numbers. The referee
  collapses an IC's pins to component granularity when one side names and the
  other numbers — naming keeps the comparison pin-accurate.
- Keep **unit conventions consistent** ("100k" vs "100kΩ" compare as different).
- `topologyPass` ignores values; value correctness is gated separately via
  `valueAccuracy`.

## Status of the shipped goldens

Both current datasheet goldens (`ams1117-3.3`, `mp2315`) are **DRAFTS authored
from general knowledge, `verified: false`** — they exist so the harness runs
end-to-end, not as trusted truth. Verify each against the real PDF (the
manifest pins `pdf_url`; `--fetch` downloads it) before setting `verified: true`
or trusting any score derived from them.

---

## BOM-sync suite (`evals/bom-sync`)

Deterministic, no LLM, no network — CI-able today. It scores the pure
`matchSchematicToBom` matcher (lifted from `src/commands/bom/sync.ts`) against
hand-authored golden correspondences.

Each `fixtures/<case>/` provides:

- `schematic.kicad_sch` **or** `components.json` — the schematic component list.
  A `.kicad_sch` is parsed by the shipped `readSchematicComponents` (so the
  regex parser is exercised); `components.json` is the parsed `KicadComponent[]`
  for cases where authoring raw S-expr is not worth it. `clean-1to1`,
  `multi-ref`, and `fp-mismatch` take the `.kicad_sch` route.
- `bom.json` — a full `BomDatabase` (validated with the shipped Zod schema).
- `golden.json` — the expected correspondence: `refToEntry` (clean matches),
  `unmatchedSchRefs`, `footprintMismatches`, `ambiguousRefs`, `orphanedEntryIds`.

Cases: `clean-1to1`, `multi-ref` (one entry, refs fold in), `missing-in-bom`
(schematic part with no entry), `orphan-bom` (entry with no schematic ref),
`fp-mismatch` (ref matches but footprint disagrees → flagged, not clean-matched).

Scorer: pair precision/recall/F1 over `(ref → entry)` plus Jaccard + exactness
of each set. `exact` (every pair and set reproduced) is the gate — this suite is
deterministic, so a non-exact fixture is a hard failure even on a fresh baseline.

## Search suite (`evals/search`)

`manifest.json` holds ~10 realistic golden queries; each carries an `anyOf` set
of acceptable LCSC ids, attribute `predicates` the top hit must satisfy
(`packageEquals`, `descriptionRegex`/`mpnRegex` — a leading `(?i)` inline flag is
supported, `inStock`, `hasFootprint`), and a `forbidden` id set.

Recordings under `recordings/<query-id>.json` hold the top-20 whitelisted hits.
Replay (default) scores from them and **skips-with-reason** when a query has no
recording. `--live` hits the shipped `searchComponents` client and records.
LCSC is blocked here (403), so only replay is exercised; the three shipped
recordings are `synthetic: true`, hand-authored so the scorer is fully tested
offline. Metrics: hit@1, hit@5, MRR, predicate pass rate, forbidden-hit rate;
a forbidden hit halves the headline.

## Review suite (`evals/review`, stretch)

Two seeded-defect fixtures: `missing-decoupling` (LDO with no input bypass cap)
and `swapped-feedback` (buck feedback divider inverted → wrong Vout). Each
`fixtures/<case>/` has a `netlist.xml` (`parseNetlistXml`-compatible), a
`bom.json`, and a `golden.json` with the seeded `defect` and a `mustMention`
list of regex criteria (each with a literal `sample` used to synthesize the
dry-run review).

The runner assembles a netlist+BOM review context. **Dry-run (default)** feeds
the scorer a synthesized review that satisfies every criterion — a plumbing
check, not a quality measurement. `--live` makes a single Anthropic call
(reusing `evals/src/transport.ts`) over the context and scores the model's
answer; it is implemented but **untested** here (no key in CI). The scorer
reports recall over the criteria and `allFound` (the gate).
