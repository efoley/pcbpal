# pcbpal Design Documents

## Document Index

### Core Design
- **[pcbpal-design.md](./pcbpal-design.md)** — Overview, schema definitions (BOM, production,
  subcircuits), CLI command structure, serialization decisions, implementation stack.
  This is the primary reference document.

- **[cli_human_vs_llm.md](./cli_human_vs_llm.md)** — How the CLI handles dual-mode usage
  (human-interactive vs LLM-agent-driven). Core/presentation split pattern, context
  detection, JSON output contracts, Claude Code integration via CLAUDE.md.

### Planned Documents

- **tscircuit_bridge.md** — How pcbpal integrates with the tscircuit ecosystem.
  Covers: the TSX → Circuit JSON → KiCad pipeline, which tscircuit packages are
  used and how, the kicad-converter round-trip (capabilities and known gaps),
  subcircuit → KiCad hierarchical sheet mapping (nets, labels, refdes prefixing),
  and rendering pipeline (circuit-to-svg, circuit-to-png). Should include a
  concrete worked example: a small subcircuit going from TSX to .kicad_sch.

- **bom_and_parts.md** — The component search and BOM management subsystem.
  Covers: LCSC/EasyEDA API integration (via easyeda-converter), symbol/footprint
  fetching and KiCad library injection, BOM lifecycle (candidate → selected →
  ordered → verified), the relationship between BOM entries and KiCad reference
  designators, alternate part tracking, and BOM sync with the schematic. Should
  include the JSON schema examples for typical entries (passives, ICs, antennas).

- **production_pipeline.md** — Fabrication and assembly workflow. Covers: the
  stackup database (how fab-house stackups are modeled, where the data comes from),
  controlled impedance calculation (GCPW, microstrip, stripline formulas and how
  they use the stackup Dk/thickness), Gerber/drill export via kicad-cli, BOM
  export in JLC format, pick-and-place file generation, and the `production check`
  validation logic (what rules it enforces).

- **kicad_integration.md** — All the ways pcbpal touches KiCad. Covers: file
  format parsing/serialization (S-expressions via kicad-converter), KiCad 9
  IPC API for live interaction (when/why to use it vs file manipulation),
  kicad-cli for exports (SVG, Gerbers, DRC, BOM), library table management
  (how pcbpal injects its symbols/footprints non-destructively), and the
  schematic review pipeline (export → SVG → LLM context).

- **project_structure.md** — File layout conventions, how pcbpal coexists with
  a KiCad project on disk, what goes in version control vs .pcbpal/ cache,
  the pcbpal.toml config reference, and how `pcbpal init` bootstraps everything.

## Implementation Priorities

Suggested order for building pcbpal, based on standalone utility at each stage:

### Phase 1: Search + BOM (immediately useful, no tscircuit dependency)
- `pcbpal init`
- `pcbpal search` (LCSC API)
- `pcbpal bom add / show / remove / link`
- `pcbpal lib fetch` (download symbol/footprint from LCSC)
- `pcbpal doctor` (basic health checks)
- Core/presentation split from day one, `--json` everywhere

### Phase 2: Production + Review (end-to-end useful with KiCad doing schematics)
- `pcbpal production stackup` (with JLC stackup database)
- `pcbpal production impedance` (trace geometry calculator)
- `pcbpal production check` (DRC + BOM validation)
- `pcbpal production export` (Gerber + BOM + PnP ZIP)
- `pcbpal review --prepare-only` (context assembly for LLM review)
- `pcbpal review` (standalone LLM review for terminal use)

Phases 1 + 2 give a complete workflow (find parts → BOM → stackup → impedance
→ export production package) without any tscircuit dependency. Schematics and
PCB layout stay entirely in KiCad.

### Phase 3: Subcircuits + Rendering (tscircuit integration)
- `pcbpal sub new / build / preview`
- `pcbpal sub export --to kicad`
- Circuit JSON rendering pipeline
- CLAUDE.md template for Claude Code integration

This is the most speculative phase — depends on kicad-converter's schematic
serialization being robust and the TSX → hierarchical sheet mapping working
cleanly. Better to validate after the rest of pcbpal is already useful.

### Phase 4: Polish + Ecosystem
- `pcbpal bom sync` (schematic ↔ BOM reconciliation)
- `pcbpal bom cost` (multi-quantity pricing)
- DigiKey/Mouser search support
- Watch mode for subcircuit hot-reload during `tsci dev`
- KiCad IPC API integration for live board interaction
