# Datasheet extraction eval harness

Measures whether LLM datasheet extractions are **faithful** — no hallucinated
values, no dropped connections — so prompt/model/strategy changes get a
regression signal instead of vibes. Spec: `design-docs/datasheet_understanding_evals.md` §6.

This harness lives outside `src/` (it is not shipped) and, unlike pcbpal core,
is allowed to call LLM APIs. It is **offline-first**: the whole pipeline runs
with no network and no API key via `--dry-run`, which feeds each strategy the
golden extraction through a mock transport. Live runs happen on a machine with
`poppler-utils` and `ANTHROPIC_API_KEY`.

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

Both current goldens (`ams1117-3.3`, `mp2315`) are **DRAFTS authored from
general knowledge, `verified: false`** — they exist so the harness runs
end-to-end, not as trusted truth. Verify each against the real PDF (the
manifest pins `pdf_url`; `--fetch` downloads it) before setting `verified: true`
or trusting any score derived from them.
