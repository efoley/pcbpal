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
```

### Fetch KiCad symbols and footprints

```bash
pcbpal lib fetch C1525               # downloads symbol, footprint, and 3D model into .pcbpal/lib/
pcbpal lib fetch C1525 --symbol      # symbol only (.kicad_sym)
pcbpal lib fetch C1525 --footprint   # footprint only (.pretty/)
pcbpal lib fetch C1525 --3d          # 3D model only (.wrl)
```

Files are written to `.pcbpal/lib/<LCSC>.kicad_sym`, `.pcbpal/lib/<LCSC>.pretty/`,
and `.pcbpal/lib/<LCSC>.wrl`. Add `.pcbpal/lib/` to your KiCad symbol and
footprint library paths to use them in schematics and layout.

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

### Health check

```bash
pcbpal doctor                        # validates all project files, checks kicad-cli
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

## Workflow guidance

When selecting components:
1. Use `pcbpal search` to find candidates
2. Add candidates with `pcbpal bom add` (status defaults to `candidate`)
3. Prefer **basic** (B) parts over **extended** (E) for JLCPCB assembly — lower fees
4. Record why a part was chosen using `--selection-notes`
5. Once finalized, update status to `selected`
6. Use `pcbpal lib fetch` to get the KiCad symbol/footprint
7. Link to schematic refs with `pcbpal bom link`

When reviewing the BOM, check:
- All entries have a source with stock > 0
- No duplicate roles without justification
- Controlled-impedance nets have matching profiles in production config
- `pcbpal doctor` passes cleanly
