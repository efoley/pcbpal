# {{PROJECT_NAME}} — PCB project

This is a KiCad PCB project managed with **pcbpal**. pcbpal owns the intent
layer (what parts, why, production constraints); KiCad owns the implementation
(schematics, layout, copper).
{{KICAD_LINE}}
## Project files

| File | Format | Purpose |
|------|--------|---------|
| `pcbpal.toml` | TOML | Project config (name, KiCad project path, fab defaults) |
| `pcbpal.bom.json` | JSON | Bill of materials — the source of truth for component selection |
| `pcbpal.production.json` | JSON | Board specs, stackup, impedance profiles, fab/assembly settings |
| `.pcbpal/` | — | Cache directory (gitignored). Downloaded symbols, footprints, API cache |
| `subcircuits/` | TSX | tscircuit subcircuit definitions (optional) |

Do not hand-edit the JSON files — use pcbpal commands so that validation
(Zod schemas) runs on every read/write.

## pcbpal CLI commands

All commands support `--json` for structured output.

### Search for components

```bash
pcbpal search "100nF 0402"           # keyword search on LCSC/JLCPCB
pcbpal search --lcsc C1525           # look up a specific LCSC part
pcbpal search "ESP32" --in-stock     # only in-stock parts
pcbpal search "10k 0402" --max-price 0.01
```

Search results include: LCSC#, basic/extended type, MPN, description,
package, stock, price, and product page URL.

### Manage the BOM

```bash
# View
pcbpal bom show                      # all entries
pcbpal bom show --category passive   # filter by category
pcbpal bom show --status selected    # filter by status

# Add — either specify details manually or auto-populate from LCSC
pcbpal bom add --role "Decoupling cap for U1" --category passive --lcsc C1525
pcbpal bom add --lcsc C1525 --category passive   # role auto-fills from LCSC description
pcbpal bom add --role "Board-to-board connector" --category connector --mpn "DF40C-60DP-0.4V(51)"

# Remove and link
pcbpal bom remove <id-or-prefix>
pcbpal bom link <id-or-prefix> C1,C2,C3   # associate KiCad reference designators

# Sync with schematic
pcbpal bom sync                      # auto-populate BOM from KiCad schematic
pcbpal bom sync --dry-run            # show what would change without writing
pcbpal bom sync --online             # also fetch part details from LCSC API
```

`bom sync` reads all KiCad schematics, groups components by value + footprint,
and creates BOM entries for new components. If a `jlcpcb/project.db` exists
(from the JLCPCB KiCad plugin), it auto-imports LCSC part numbers. It also
updates refs on existing entries and flags orphaned entries whose refs no longer
appear in the schematic.

```bash
# Verify BOM
pcbpal bom check                     # check stock, packages, refs against LCSC + schematic
pcbpal bom check --offline           # local-only checks (no API calls)
```

`bom check` reads the KiCad schematic to cross-reference footprints. It verifies:
- Every BOM entry has a supplier source and linked KiCad refs
- Linked refs exist in the schematic
- All refs for an entry use the same footprint
- LCSC package names roughly match the KiCad footprint assigned in the schematic
- Parts are in stock on LCSC (online mode)
- Extended parts are flagged (higher JLCPCB assembly fee)
- No duplicate ref assignments across entries

All `bom` subcommands support `--from-jlcpcb` to read the BOM from the
JLCPCB KiCad plugin's `jlcpcb/project.db` instead of `pcbpal.bom.json`.
If the pcbpal BOM is empty and `jlcpcb/project.db` exists, `bom check`
auto-detects it.

#### Footprint geometry check

```bash
pcbpal bom footprint-check                   # compare KiCad vs LCSC footprint geometry
pcbpal bom footprint-check --refs U2,J1      # check specific components only
pcbpal bom footprint-check --no-render       # skip SVG rendering
pcbpal bom footprint-check --from-jlcpcb     # read BOM from JLCPCB plugin DB
```

`footprint-check` downloads the LCSC footprint for each component (via
`easyeda2kicad`), parses the `.kicad_mod` geometry, and compares:
- Pad count
- Bounding box dimensions
- Per-pad position and size (matched by pad number)

For mismatches and unclear results, it renders both footprints to SVG
(with colored layers: copper, silkscreen, paste, courtyard) in
`.pcbpal/footprint-check/<ref>/` for side-by-side visual inspection.

### Fetch KiCad symbols and footprints

```bash
pcbpal lib fetch C1525               # downloads symbol, footprint, and 3D model into .pcbpal/lib/
pcbpal lib fetch C1525 --symbol      # symbol only (.kicad_sym)
pcbpal lib fetch C1525 --footprint   # footprint only (.pretty/)
pcbpal lib fetch C1525 --3d          # 3D model only (.wrl)
pcbpal lib install                   # merge and register all fetched libraries in KiCad
pcbpal lib list                      # show all symbols with their footprints
pcbpal lib assign-footprint R1,R2,R3 "Resistor_SMD:R_0402_1005Metric"  # set in schematic
```

`lib fetch` downloads to `.pcbpal/lib/<LCSC>.kicad_sym`, `.pcbpal/lib/<LCSC>.pretty/`,
and `.pcbpal/lib/<LCSC>.wrl`. Run `lib install` afterwards — it merges all
individual symbol files into a single `pcbpal.kicad_sym` library (so they
appear under one "pcbpal" category in KiCad's chooser), consolidates footprints
into `pcbpal.pretty`, upgrades to KiCad 9 format, and registers them in the
project's `sym-lib-table` and `fp-lib-table`.

`lib list` shows all symbols with their current footprint assignment, LCSC
part number, and pin count. Use `lib assign-footprint` to set footprints on
already-placed components in the KiCad schematic (like KiCad's "Assign
Footprints" dialog, but from the CLI):

```bash
pcbpal lib assign-footprint C1,C2,C3 "Capacitor_SMD:C_0402_1005Metric"
pcbpal lib assign-footprint R1,R2 "Resistor_SMD:R_0402_1005Metric"
```

Requires `easyeda2kicad` (`pipx install easyeda2kicad`). Run `pcbpal doctor`
to check that it's installed.

### Subcircuits (tscircuit)

Subcircuits are reusable circuit blocks defined as TSX files using tscircuit
components (`<board>`, `<resistor>`, `<capacitor>`, `<trace>`, etc.). pcbpal
compiles them to Circuit JSON, renders previews, and exports to KiCad format.

```bash
pcbpal sub new voltage-divider       # scaffold subcircuits/voltage-divider.tsx
pcbpal sub list                      # list all subcircuits and build status
pcbpal sub build voltage-divider     # compile TSX → Circuit JSON (.pcbpal/builds/)
pcbpal sub build --all               # build all subcircuits
pcbpal sub preview voltage-divider   # render schematic SVG (.pcbpal/preview/)
pcbpal sub preview voltage-divider --view pcb   # PCB layout SVG
pcbpal sub export voltage-divider    # export to .kicad_sch
pcbpal sub export voltage-divider --format kicad_pcb  # export to .kicad_pcb
```

Subcircuit TSX files use standard tscircuit JSX. Example:

```tsx
export const VoltageDivider = () => (
  <board width="12mm" height="8mm">
    <resistor name="R1" resistance="10k" footprint="0402" />
    <resistor name="R2" resistance="10k" footprint="0402" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
  </board>
)
export default VoltageDivider
```

The workflow for subcircuits:
1. `pcbpal sub new <name>` — creates a template TSX file
2. Edit the TSX file to define your circuit
3. `pcbpal sub build <name>` — compiles and validates (reports component/net counts, errors)
4. `pcbpal sub preview <name>` — renders an SVG to visually inspect
5. `pcbpal sub export <name>` — generates a `.kicad_sch` you can include as a hierarchical sheet

No need to install tscircuit in your project — pcbpal handles it.

### Production export

```bash
pcbpal production export                     # generate gerbers + drill + BOM + CPL + ZIP
pcbpal production export --from-jlcpcb       # use JLCPCB plugin DB for part assignments
pcbpal production export --use-drill-origin  # use drill/place file origin for positions
pcbpal production export --output ./output   # custom output directory
```

Generates a complete JLCPCB submission package in `.pcbpal/production/`:
- **Gerbers** — all copper layers (auto-detected from board), silkscreen,
  solder mask, paste, edge cuts
- **Drill files** — Excellon format, separate PTH and NPTH
- **BOM CSV** — JLCPCB format (Comment, Designator, Footprint, LCSC, Quantity)
- **CPL CSV** — JLCPCB format (Designator, Val, Package, Mid X, Mid Y, Rotation, Layer)
- **ZIP** — gerbers + drill files bundled for upload

Uses `kicad-cli` for gerber/drill/position export and applies placement
corrections from `pcbpal.production.json` to the CPL.

#### Placement corrections

KiCad and JLCPCB often disagree on the 0-degree orientation for a given
footprint (e.g. SOT-23 may need a 180° correction). Add corrections to
`pcbpal.production.json`:

```json
"placement_corrections": [
  { "pattern": "SOT-23$", "match_on": "footprint", "rotation": 180 },
  { "pattern": "SOT-23-[56]", "match_on": "footprint", "rotation": 90 },
  { "pattern": "SOIC-", "match_on": "footprint", "rotation": 90 }
]
```

Each correction has:
- **pattern** — regex matched against the footprint name, reference, or value
- **match_on** — what to match: `footprint` (default), `reference`, or `value`
- **rotation** — degrees to add to KiCad's rotation
- **offset_x**, **offset_y** — positional adjustment in mm (optional)

Use `pcbpal bom footprint-check` to detect rotation differences between
KiCad and LCSC footprints — the "unclear" results are often pure rotation
offsets that should become placement corrections.

### Design review context

```bash
pcbpal review schematic              # export all schematic sheets as SVGs + context
pcbpal review schematic --sheet 2    # specific sheet only
pcbpal review pcb                    # export PCB layout SVG + context
pcbpal review drc                    # run DRC, export violations as JSON + PCB SVG
pcbpal review bom                    # export BOM summary + schematic SVGs
pcbpal review bom --from-jlcpcb     # use JLCPCB plugin DB for BOM data
```

`review` assembles a context package in `.pcbpal/review/` for design review
by Claude Code or other tools. It does not call an LLM itself — it prepares
the data. The output includes:
- SVG images (schematic sheets, PCB layout)
- `context.json` with structured data: component list, BOM summary,
  production config, DRC violations (for `drc` target)
- Additional context files can be included with `--context file1,file2`

With `--json`, the full context data is emitted to stdout for programmatic use.

### Health check

```bash
pcbpal doctor                        # validates all project files, checks kicad-cli, easyeda2kicad
```

## BOM data model

Each BOM entry has:

- **role** — what this component does in the design (e.g. "decoupling cap for U1 VDDIO",
  "BLE chip antenna", "USB-C connector"). This is the design-intent label, not the
  manufacturer's generic description.
- **category** — one of: `ic`, `passive`, `connector`, `antenna`, `crystal`,
  `inductor`, `diode`, `led`, `transistor`, `sensor`, `power`, `mechanical`, `other`
- **status** — lifecycle: `candidate` → `selected` → `ordered` → `verified`
- **sources** — supplier part numbers (LCSC, DigiKey, Mouser) with price/stock
- **kicad_refs** — linked KiCad reference designators (e.g. C1, C2, U3)
- **alternates** — alternate parts considered, with `why_not` notes
- **selection_notes** — why this specific part was chosen
- **subcircuit** — logical grouping (e.g. "power", "rf_frontend", "usb")

## Production config

`pcbpal.production.json` tracks:

- **Board specs** — thickness, min trace/space, min drill, via size, surface finish
- **Stackup** — fab house stackup ID with layer details (copper, prepreg, core)
- **Controlled impedance** — profiles with target ohms, trace geometry, net classes
- **Fabrication** — fab house, quantity, panelization, notes
- **Assembly** — assembly house, which sides, manual placement parts
- **Placement corrections** — per-footprint rotation/offset corrections for JLCPCB CPL

## Workflow guidance

When selecting components:
1. Use `pcbpal search` to find candidates
2. Add candidates with `pcbpal bom add` (status defaults to `candidate`)
3. Prefer **basic** (B) parts over **extended** (E) for JLCPCB assembly — lower fees
4. Record why a part was chosen using `--selection-notes`
5. Once finalized, update status to `selected`
6. Use `pcbpal lib fetch` to get the KiCad symbol/footprint
7. Run `pcbpal bom sync` to auto-link refs and import parts from schematic
8. Run `pcbpal bom check` to verify stock, footprint matching, and consistency

When reviewing the BOM, run `pcbpal bom check` — it will:
- Cross-reference linked refs against the KiCad schematic
- Verify LCSC packages match the schematic footprints
- Flag out-of-stock or extended parts
- Catch duplicate ref assignments and missing sources
