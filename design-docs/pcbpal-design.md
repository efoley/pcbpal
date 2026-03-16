# pcbpal — Schema & CLI Design

## Design Philosophy

pcbpal is a **companion tool**, not a replacement EDA. It owns the *intent layer* — what
you're trying to build, which parts you chose and why, what the production constraints are —
while the EDA (KiCad) owns the *implementation layer* — actual wiring, placement, copper.

The schema should be:

- **Human-readable and git-friendly** — you'll check this into the same repo as your KiCad project
- **LLM-friendly** — Claude/Gemini should be able to read and generate fragments naturally
- **Incrementally adoptable** — you can start with just the BOM and add other features over time

---

## Schema Format: Why Not Protobuf

Protobuf is the right choice for IPC (KiCad 9 uses it for its API socket), but it's the
wrong choice for project files because:

- Binary by default — bad for git diffs, bad for LLM context windows
- Requires codegen toolchain — friction for a CLI tool that should "just work"
- Schema evolution is oriented around wire compat, not human editing

**The better fit: TypeScript types + Zod schemas, serialized as JSON (or TOML for the top-level config).**

This aligns with the tscircuit ecosystem (which already uses Zod throughout), works natively
in a Node/Bun CLI, and means the schema definitions *are* the validation code. For the
project-level config (stuff you'd hand-edit), TOML is friendlier. For structured data like
the BOM database, JSON.

The file layout in a project would look like:

```
my-board/
├── my-board.kicad_pro          # KiCad project (KiCad owns this)
├── my-board.kicad_sch          # Root schematic (KiCad owns this)
├── my-board.kicad_pcb          # PCB layout (KiCad owns this)
├── pcbpal.toml                 # pcbpal project config (human-edited)
├── pcbpal.bom.json             # BOM database (pcbpal-managed)
├── pcbpal.production.json      # Production config (pcbpal-managed)
├── subcircuits/                 # tscircuit TSX sub-schematics
│   ├── debounced-button.tsx
│   ├── nmos-led-driver.tsx
│   └── ldo-3v3.tsx
└── .pcbpal/                    # Cache/generated (gitignored)
    ├── symbols/                # Fetched KiCad symbols from LCSC
    ├── footprints/             # Fetched KiCad footprints from LCSC
    ├── datasheets/             # Cached PDFs
    └── reviews/                # LLM review history
```

---

## Schema Definitions

### pcbpal.toml — Project Config

```toml
[project]
name = "nrf52-boxing-sensor"
version = "0.2.0"
description = "BLE boxing impact sensor with LSM6DS3 IMU"
kicad_project = "boxing-sensor.kicad_pro"  # relative path

[eda]
tool = "kicad"
version = "9.0"                             # minimum KiCad version
ipc_api = true                              # enable live KiCad IPC bridge

[libraries]
# Where pcbpal should install fetched symbols/footprints
# These get added to KiCad's library tables automatically
symbol_lib = "pcbpal-symbols.kicad_sym"
footprint_lib = "pcbpal-footprints.pretty"

[llm]
provider = "anthropic"                      # or "google", "openai"
model = "claude-sonnet-4-20250514"
review_on_save = false                      # auto-review schematics on file change

[production]
default_fab = "jlcpcb"
default_assembly = "jlcpcb"
```

### pcbpal.bom.json — BOM Database

This is the core data structure. Each entry represents a *design intent* — not just a
part number, but why that part was chosen and what constraints it must satisfy.

```typescript
// bom.schema.ts
import { z } from "zod";

const PartSource = z.object({
  supplier: z.enum(["lcsc", "digikey", "mouser", "manual"]),
  part_number: z.string(),                    // e.g. "C123456" for LCSC
  url: z.string().url().optional(),
  unit_price_usd: z.number().optional(),
  stock: z.number().int().optional(),
  last_checked: z.string().datetime().optional(),
});

const PartConstraints = z.object({
  // Parametric constraints — what matters about this part
  // These are freeform key-value so they work for any component type
  parameters: z.record(z.string(), z.union([
    z.string(),
    z.number(),
    z.object({
      min: z.number().optional(),
      nom: z.number().optional(),
      max: z.number().optional(),
      unit: z.string(),
    }),
  ])).optional(),

  // Package constraints
  package: z.string().optional(),             // e.g. "0402", "QFN-48"
  footprint_ref: z.string().optional(),       // KiCad footprint name

  // RF/signal integrity constraints
  impedance: z.object({
    target_ohms: z.number(),
    tolerance_pct: z.number().optional(),
    frequency_hz: z.number().optional(),
  }).optional(),
});

const BomEntry = z.object({
  id: z.string().uuid(),                      // stable ID for cross-referencing
  role: z.string(),                           // human-readable: "BLE chip antenna"
  description: z.string().optional(),         // longer notes

  // What this part IS
  category: z.enum([
    "ic", "passive", "connector", "antenna", "crystal",
    "inductor", "diode", "led", "transistor", "sensor",
    "power", "mechanical", "other",
  ]),

  // The chosen part
  manufacturer: z.string().optional(),        // "Johanson Technology"
  mpn: z.string().optional(),                 // "2450AT18B100E"
  sources: z.array(PartSource).default([]),

  // Why this part was chosen
  constraints: PartConstraints.optional(),
  selection_notes: z.string().optional(),     // "Chosen per Nordic AN91445 Table 3"
  datasheet_url: z.string().url().optional(),

  // Placement, routing, and general design notes
  // Freeform — covers things like "keep within 5mm of U1", "thermal vias under
  // pad", "match trace lengths in this group", "orient pin 1 toward board edge"
  notes: z.string().optional(),

  // Where it's used in the schematic
  kicad_refs: z.array(z.string()).default([]),  // ["C12", "C13"] — reference designators
  kicad_symbol: z.string().optional(),          // "Device:C" or custom
  kicad_footprint: z.string().optional(),       // "Capacitor_SMD:C_0402_..."
  subcircuit: z.string().optional(),            // which subcircuit this belongs to

  // Alternatives considered
  alternates: z.array(z.object({
    mpn: z.string(),
    source: PartSource.optional(),
    why_not: z.string().optional(),           // "out of stock", "worse Q factor"
  })).default([]),

  // Lifecycle
  status: z.enum(["candidate", "selected", "ordered", "verified"]).default("candidate"),
  added: z.string().datetime(),
  updated: z.string().datetime(),
});

const BomDatabase = z.object({
  schema_version: z.literal(1),
  entries: z.array(BomEntry),
});
```

### pcbpal.production.json — Fabrication Config

The key insight: you don't control individual layer materials — you choose a
fab-house-specific stackup ID (e.g. "JLC04161H-7628") and that determines
everything. pcbpal ships with (or fetches) a database of known stackups per
fab house, so it can auto-populate the layer details for impedance calculations.

```typescript
// Individual layer within a stackup — populated from the stackup database,
// not hand-edited. Included in production.json for reference and so the
// impedance calculator has the Dk/Df values without a separate lookup.
const StackupLayer = z.object({
  type: z.enum(["copper", "prepreg", "core", "soldermask", "silkscreen", "paste"]),
  name: z.string().optional(),                  // "F.Cu", "In1.Cu", "prepreg-1"
  thickness_mm: z.number(),
  copper_weight_oz: z.number().optional(),      // 0.5, 1, 2

  // Dielectric properties (for prepreg/core layers)
  laminate_code: z.string().optional(),         // "7628", "3313", "2116", "1080"
  dielectric_constant: z.number().optional(),   // Dk at target frequency
  loss_tangent: z.number().optional(),          // Df
  resin_content_pct: z.number().optional(),
});

// A complete stackup selection — references a fab house's named configuration.
// The layers array is auto-populated when you select a stackup_id.
const FabStackup = z.object({
  fab_house: z.enum(["jlcpcb", "pcbway", "oshpark", "other"]),
  stackup_id: z.string(),                      // "JLC04161H-7628", "JLC04161H-3313"
  layer_count: z.number().int(),                // 2, 4, 6
  total_thickness_mm: z.number(),               // calculated from layers
  layers: z.array(StackupLayer),                // auto-populated from stackup DB
});

const ControlledImpedance = z.object({
  name: z.string(),                             // "50ohm_gcpw_top"
  type: z.enum(["microstrip", "stripline", "coplanar", "gcpw"]),
  target_ohms: z.number(),
  tolerance_pct: z.number().default(10),

  // Geometry — can be specified manually or calculated by pcbpal from the stackup
  trace_width_mm: z.number().optional(),
  gap_mm: z.number().optional(),                // coplanar/GCPW gap to ground pour
  signal_layer: z.string().optional(),          // "F.Cu"
  reference_layer: z.string().optional(),       // "In1.Cu"

  // Which KiCad net classes use this impedance profile
  net_classes: z.array(z.string()).default([]),
  notes: z.string().optional(),

  // Calculated results (filled in by `pcbpal production impedance`)
  calculated: z.object({
    trace_width_mm: z.number(),
    gap_mm: z.number().optional(),
    impedance_ohms: z.number(),                 // actual calculated Z0
    dk_used: z.number(),                        // Dk value used in calculation
    dielectric_height_mm: z.number(),           // substrate height used
  }).optional(),
});

const ProductionConfig = z.object({
  schema_version: z.literal(1),

  board: z.object({
    thickness_mm: z.number().default(1.6),
    min_trace_mm: z.number().default(0.127),    // 5mil
    min_space_mm: z.number().default(0.127),
    min_drill_mm: z.number().default(0.3),
    min_via_diameter_mm: z.number().default(0.6),
    surface_finish: z.enum(["hasl", "enig", "osp", "immersion_silver"]).default("enig"),
  }),

  stackup: FabStackup,
  controlled_impedance: z.array(ControlledImpedance).default([]),

  fabrication: z.object({
    fab_house: z.enum(["jlcpcb", "pcbway", "oshpark", "other"]).default("jlcpcb"),
    quantity: z.number().int().default(5),
    panelization: z.boolean().default(false),
    notes: z.array(z.string()).default([]),
  }),

  assembly: z.object({
    assembly_house: z.enum(["jlcpcb", "pcbway", "manual", "other"]).default("jlcpcb"),
    sides: z.enum(["top", "bottom", "both"]).default("top"),
    // Parts that need hand-soldering or aren't in JLC's library
    manual_parts: z.array(z.string()).default([]),  // BOM entry IDs
  }).optional(),
});
```

pcbpal includes a bundled stackup database at `.pcbpal/stackup-db.json` that maps
fab house stackup IDs to their full layer structures. For JLCPCB, this covers
configurations like:

- `JLC04161H-7628` — 4L 1.6mm, 7628 prepreg (Dk≈4.6, thick ~0.19mm)
- `JLC04161H-3313` — 4L 1.6mm, 3313 prepreg (Dk≈4.05, thin ~0.1mm)
- `JLC04161H-2116` — 4L 1.6mm, 2116 prepreg (Dk≈4.25, ~0.12mm)

The `pcbpal production stackup` command presents these options interactively,
auto-populates the layers, and then `pcbpal production impedance` uses the
Dk/thickness values to calculate trace geometries.

### Subcircuit TSX Files

These are standard tscircuit components. pcbpal adds a convention: a frontmatter
comment block that links the subcircuit to the BOM and documents the interface.

```tsx
// subcircuits/debounced-button.tsx
/**
 * @pcbpal subcircuit
 * @role Debounced tactile switch with pull-up
 * @interface
 *   VCC: power input (3.3V)
 *   GND: ground
 *   OUT: debounced output, active low
 * @bom-refs SW1, R_PU, C_DB
 */
import { useChip, useResistor, useCapacitor } from "@tscircuit/core";

export const DebouncedButton = ({
  pullup = "10k",
  debounce_cap = "100nF",
}: {
  pullup?: string;
  debounce_cap?: string;
}) => (
  <subcircuit name="SW_DEBOUNCE">
    <chip
      name="SW1"
      footprint="pcbpal:CK_PTS636_SM25F"
      pinLabels={{ 1: "A", 2: "B" }}
    />
    <resistor name="R_PU" resistance={pullup} footprint="0402" />
    <capacitor name="C_DB" capacitance={debounce_cap} footprint="0402" />

    {/* Pull-up to VCC */}
    <trace from=".R_PU > .pin1" to="net.VCC" />
    <trace from=".R_PU > .pin2" to=".SW1 > .A" />

    {/* Switch to ground */}
    <trace from=".SW1 > .B" to="net.GND" />

    {/* Debounce cap */}
    <trace from=".C_DB > .pin1" to=".SW1 > .A" />
    <trace from=".C_DB > .pin2" to="net.GND" />

    {/* Output is the switch node */}
    <trace from=".SW1 > .A" to="net.OUT" />
  </subcircuit>
);
```

---

## CLI Structure

### Top-Level Commands

```
pcbpal <command> [subcommand] [options]

Global flags (apply to all commands):
  --json            Output structured JSON instead of human-formatted text
  --quiet           Suppress non-essential output

Commands:
  init          Initialize pcbpal in an existing KiCad project
  search        Search for components across suppliers
  bom           Manage the bill of materials
  lib           Manage local symbol/footprint libraries
  sub           Manage tscircuit subcircuits (build, preview, export)
  preview       Render schematic/PCB previews (wraps kicad-cli + tscircuit)
  review        Get LLM feedback on schematics/PCBs
  production    Configure and validate production files
  export        Export BOM, Gerbers, or production packages
  doctor        Check project health and dependencies
  config        View/edit pcbpal configuration

All commands are designed to be composable and non-interactive by default,
making pcbpal usable both by humans at a terminal and by LLM agents
(Claude Code, etc.) as a tool. The --json flag is the primary integration
point: it ensures output is machine-parseable for agent consumption.
```

### pcbpal init

```
pcbpal init [--kicad-project <path>]

Scans current directory for a .kicad_pro file (or uses the provided path).
Creates pcbpal.toml, pcbpal.bom.json, pcbpal.production.json.
Optionally scans the existing schematic to bootstrap the BOM from placed components.

Options:
  --kicad-project <path>   Path to .kicad_pro file
  --import-bom             Parse existing schematic and populate BOM entries
  --no-git                 Don't create .gitignore for .pcbpal/
```

### pcbpal search

```
pcbpal search <query> [options]

Search LCSC, DigiKey, Mouser for components. Results include stock, price,
and whether a KiCad symbol/footprint is available.

Examples:
  pcbpal search "nRF52832 QFN"
  pcbpal search "chip antenna 2.4GHz" --supplier lcsc
  pcbpal search "100nF 0402 X7R" --in-stock --max-price 0.05
  pcbpal search --lcsc C123456              # lookup by part number

Options:
  --supplier <name>        Filter to specific supplier (lcsc, digikey, mouser)
  --in-stock               Only show in-stock parts
  --max-price <usd>        Maximum unit price
  --category <cat>         Filter by category
  --limit <n>              Max results (default: 20)
  --json                   Output as JSON (for piping)
  --add                    Interactive: prompt to add result to BOM

Output columns:
  LCSC#  |  MPN  |  Description  |  Package  |  Stock  |  Price  |  Footprint?
```

### pcbpal bom

```
pcbpal bom <subcommand>

Subcommands:
  show              Display current BOM (table format)
  add               Add a component to the BOM
  remove <id>       Remove a BOM entry
  edit <id>         Open BOM entry in $EDITOR (as TOML fragment)
  link <id> <refs>  Link BOM entry to KiCad reference designators
  sync              Sync BOM with current KiCad schematic
  check             Validate BOM (stock, prices, footprint availability)
  diff              Show changes since last commit/tag
  cost              Calculate total BOM cost at various quantities

Examples:
  pcbpal bom add --lcsc C123456 --role "BLE antenna" --refs "ANT1"
  pcbpal bom add --mpn "2450AT18B100E" --role "antenna match cap" \
    --notes "See Nordic AN91445" --refs "C15"
  pcbpal bom link abc123 C12,C13,C14
  pcbpal bom show --status selected --category passive
  pcbpal bom cost --qty 10,50,100
  pcbpal bom sync  # reads schematic, flags parts not in BOM

Options for 'show':
  --format <fmt>    table (default), csv, json, markdown
  --status <s>      Filter by status
  --category <c>    Filter by category
  --subcircuit <n>  Filter by subcircuit name
  --group-by <f>    Group by category, subcircuit, or status
```

### pcbpal lib

```
pcbpal lib <subcommand>

Manage the local pcbpal symbol/footprint library that gets injected into KiCad.

Subcommands:
  fetch <lcsc#>     Download symbol + footprint from LCSC/EasyEDA
  list              List all fetched libraries
  install           Install all BOM footprints into KiCad library tables
  update            Re-fetch all libraries (check for updates)
  clean             Remove unused cached libraries

Examples:
  pcbpal lib fetch C123456
  pcbpal lib fetch C123456 --preview      # show footprint in terminal (ASCII art)
  pcbpal lib install                       # update KiCad sym-lib-table / fp-lib-table

Notes:
  Uses tscircuit/easyeda-converter under the hood.
  Fetched files cached in .pcbpal/symbols/ and .pcbpal/footprints/
  KiCad library tables are updated non-destructively (pcbpal entries are tagged).
```

### pcbpal sub

```
pcbpal sub <subcommand>

Manage tscircuit subcircuit definitions and their export to KiCad.

Subcommands:
  new <n>          Scaffold a new empty subcircuit file from template
  list                List all subcircuits and their build status
  build <name|all>    Compile TSX to Circuit JSON, validate, report errors
  preview <n>      Render subcircuit as SVG/PNG (see rendering section below)
  export <name|all>   Export subcircuit as KiCad hierarchical sheet

Examples:
  pcbpal sub new voltage-divider
  pcbpal sub build antenna-match --json
  pcbpal sub preview antenna-match --open
  pcbpal sub preview antenna-match --view pcb --format png
  pcbpal sub build --all
  pcbpal sub export debounced-button --to kicad

The 'build' subcommand (designed for both humans and LLM agents):
  Compiles TSX -> Circuit JSON, runs validation, returns structured results.
  With --json: { ok: bool, components: int, nets: int, errors: [...], warnings: [...] }
  Errors include line numbers and clear descriptions for LLM consumption.

The 'export' subcommand:
  1. Compiles TSX -> Circuit JSON
  2. Converts Circuit JSON -> KiCad schematic (.kicad_sch)
  3. Creates hierarchical labels for interface nets (VCC, GND, OUT, etc.)
  4. Optionally inserts a sheet reference into the root schematic
```

#### pcbpal as a tool for Claude Code (not its own LLM shell)

The original design had `pcbpal sub edit` as a Claude Code-style interactive
REPL with its own LLM loop. **This is the wrong abstraction.** Building an
LLM REPL inside pcbpal means building a worse Claude Code. The better model:

- **pcbpal provides composable, non-interactive CLI commands** that report
  structured output (JSON with `--json`, human-readable by default).
- **Claude Code (or any LLM agent) orchestrates** by calling pcbpal commands
  as tools, reading the output, and deciding what to do next.
- **pcbpal can be registered as a Claude Code skill or MCP server**, exposing
  its commands as tools with typed schemas.

This means every pcbpal command should be designed to work well both for a
human at a terminal AND for an LLM agent calling it programmatically.

**Design principles for Claude Code compatibility:**

1. **Every command supports `--json` output** — structured, parseable results
   that an LLM can consume without scraping terminal formatting.

2. **Commands are idempotent and composable** — `pcbpal sub build foo` always
   recompiles from the TSX source, `pcbpal bom add` with the same LCSC# is a
   no-op or update, etc.

3. **File-centric workflow** — the TSX files, BOM JSON, and production JSON are
   the source of truth. Claude Code edits the files directly (as it does with
   any code), then calls pcbpal to validate, render, or export.

4. **Preview commands write files, not terminal graphics** — `pcbpal sub preview`
   writes an SVG/PNG to a known path and prints the path. Claude Code can then
   show the image to the user, or the user can open it in their viewer.

5. **Validation commands return structured errors** — `pcbpal sub build` returns
   a JSON array of errors/warnings that Claude Code can reason about.

**The Claude Code workflow for editing a subcircuit:**

```
User (to Claude Code): "Add ESD protection to the antenna-match subcircuit"

Claude Code:
  1. Reads subcircuits/antenna-match.tsx (it's just a file)
  2. Reads pcbpal.bom.json for linked BOM entries and constraints
  3. Edits the TSX file with the ESD protection components
  4. Runs: pcbpal sub build antenna-match --json
     → Gets back {ok: true, components: 6, warnings: []}
  5. Runs: pcbpal sub preview antenna-match --svg --output .pcbpal/preview.svg
     → Shows the SVG to the user
  6. User says "looks good, but use a TVS diode instead of the zener"
  7. Claude Code edits the TSX file again
  8. Runs: pcbpal sub build antenna-match --json
  9. Runs: pcbpal sub preview antenna-match --svg --output .pcbpal/preview.svg
  10. User approves, Claude Code runs: pcbpal sub export antenna-match --to kicad
```

No special REPL needed. Claude Code already knows how to edit files, run
commands, read output, and iterate. pcbpal just needs to be a good tool.

**The Claude Code workflow for BOM + search:**

```
User: "Find a good TVS diode for the antenna line, needs to handle 2.4GHz"

Claude Code:
  1. Runs: pcbpal search "TVS diode ESD 2.4GHz" --json
     → Gets structured results with LCSC#, specs, stock, price
  2. Evaluates options, picks best candidate
  3. Runs: pcbpal bom add --lcsc C123456 --role "antenna ESD"        --refs "D1" --subcircuit antenna-match        --notes "Place within 2mm of ANT1 pad" --json
  4. Runs: pcbpal lib fetch C123456 --json
     → Downloads symbol + footprint
  5. Edits subcircuits/antenna-match.tsx to add the TVS component
  6. Runs: pcbpal sub build antenna-match --json
```

**MCP server mode (future):**

pcbpal could expose an MCP (Model Context Protocol) server that wraps its
CLI commands as tools with Zod-validated input/output schemas. This would
let Claude (in claude.ai or Claude Code) use pcbpal natively without
shelling out. The tool definitions would map 1:1 to CLI commands:

```typescript
// Conceptual MCP tool definitions
tools: [
  {
    name: "pcbpal_search",
    description: "Search LCSC/DigiKey/Mouser for components",
    input: { query: string, supplier?: string, in_stock?: boolean },
    output: { results: PartSearchResult[] }
  },
  {
    name: "pcbpal_bom_add",
    description: "Add a component to the project BOM",
    input: { lcsc?: string, mpn?: string, role: string, refs?: string[] },
    output: { entry: BomEntry }
  },
  {
    name: "pcbpal_sub_build",
    description: "Compile a tscircuit subcircuit TSX file and validate",
    input: { name: string },
    output: { ok: boolean, components: number, errors: Error[], warnings: Warning[] }
  },
  {
    name: "pcbpal_sub_preview",
    description: "Render a subcircuit as SVG schematic or PCB view",
    input: { name: string, view: "schematic" | "pcb" | "3d" },
    output: { svg_path: string, png_path?: string }
  },
  {
    name: "pcbpal_production_impedance",
    description: "Calculate controlled impedance trace geometry for the configured stackup",
    input: { type: "gcpw" | "microstrip" | ..., target_ohms: number, freq_hz?: number },
    output: { trace_width_mm: number, gap_mm?: number, calculated_z0: number }
  },
  // ... etc for every CLI command
]
```

#### Rendering pipeline

tscircuit provides a complete rendering stack that pcbpal wraps:

```
TSX source
  → @tscircuit/core (compile to Circuit JSON)
  → circuit-to-svg (schematic, PCB, assembly, pinout views)
  → SVG file on disk

For PNG (inline terminal display in kitty/iTerm2/Sixel-capable terminals):
  → circuit-to-png, or SVG → sharp/resvg for rasterization

For browser preview:
  → SVG opened in default browser, or
  → tsci dev for interactive preview with hot reload
```

The `pcbpal sub preview` command:

```
pcbpal sub preview <name> [options]

Compile subcircuit and render a visual preview.

Options:
  --view <type>     schematic (default), pcb, assembly, pinout, 3d
  --format <fmt>    svg (default), png
  --output <path>   Write to specific path (default: .pcbpal/preview/<name>-<view>.svg)
  --open            Open in default viewer after rendering
  --inline          Attempt inline terminal display (kitty/iTerm2/sixel)

Output:
  Prints the path to the generated file.
  With --json: { "path": "...", "format": "svg", "view": "schematic", "components": 4 }

Examples:
  pcbpal sub preview antenna-match --open
  pcbpal sub preview antenna-match --view pcb --format png --inline
  pcbpal sub preview antenna-match --json
```

For KiCad-native schematics/PCBs (not subcircuits), pcbpal delegates to kicad-cli:

```
pcbpal preview schematic [sheet]    # wraps kicad-cli sch export svg
pcbpal preview pcb                  # wraps kicad-cli pcb export svg
```


### pcbpal review

```
pcbpal review <target> [options]

Get LLM feedback on your design. Exports the target as image + structured data,
sends to the configured LLM with domain-specific prompting.

Targets:
  schematic [sheet]    Review schematic (all sheets or specific sheet)
  pcb                  Review PCB layout
  bom                  Review BOM for issues (cost, availability, alternatives)
  production           Review production config against design rules
  drc                  Parse KiCad DRC output and get explanations/fixes

Examples:
  pcbpal review schematic                    # all sheets
  pcbpal review schematic power              # just the power sheet
  pcbpal review pcb --focus "U1 area"        # focus on region around U1
  pcbpal review bom --check-stock
  pcbpal review drc                          # run KiCad DRC, interpret results

Options:
  --provider <name>    Override LLM provider
  --model <name>       Override model
  --context <file>     Include additional context (datasheet PDF, app note, etc.)
  --save               Save review to .pcbpal/reviews/
  --diff               Only review changes since last review
  --prepare-only       Don't call LLM — just export the context package (see below)

How it works:
  1. Export target via kicad-cli (SVG for schematic, SVG/image for PCB)
  2. Also export structured data (netlist, DRC results, BOM)
  3. Build a context package with:
     - The image(s)
     - Structured netlist/connectivity data
     - BOM entries with constraints and notes
     - Production constraints (impedance requirements, stackup)
     - Previous review history (if --diff)
  4. If --prepare-only: write context package to .pcbpal/review-context/ and stop.
     This is the intended mode for Claude Code, which does its own reasoning.
     With --json: returns { images: [paths], netlist: {...}, bom: {...}, ... }
  5. Otherwise: send to configured LLM, stream response to terminal
  6. Optionally save review with timestamp
```

### pcbpal production

```
pcbpal production <subcommand>

Configure, validate, and export production files.

Subcommands:
  stackup             Interactive stackup configuration
  impedance           Calculate/verify controlled impedance traces
  check               Validate design against production constraints
  export              Generate production-ready output package
  quote               Get estimated pricing from fab houses

Examples:
  pcbpal production stackup --fab jlcpcb --layers 4
    → Interactive: choose JLC's available stackups, set dielectric, etc.
    → Writes to pcbpal.production.json

  pcbpal production impedance --type gcpw --target 50 --freq 2.4e9
    → Calculates trace width/gap for the configured stackup
    → Suggests KiCad net class settings

  pcbpal production check
    → Runs kicad-cli DRC
    → Cross-references trace widths with impedance requirements
    → Checks BOM parts are available at assembly house
    → Validates drill sizes, via sizes, clearances against fab capabilities

  pcbpal production export --fab jlcpcb
    → Generates Gerbers via kicad-cli
    → Generates drill files
    → Generates BOM in JLC format (with LCSC part numbers from pcbpal BOM)
    → Generates pick-and-place file
    → Creates a submission-ready ZIP
    → Optionally opens JLC order page

  pcbpal production quote --qty 5,10,50
    → Estimates cost based on board specs + assembly
```

### pcbpal doctor

```
pcbpal doctor

Health check for the project. Verifies:
  ✓ KiCad project exists and is parseable
  ✓ KiCad version meets minimum requirement
  ✓ IPC API is available (if configured)
  ✓ pcbpal libraries are in KiCad's library tables
  ✓ All BOM entries have valid footprints
  ✓ All schematic components are in the BOM (or flagged as untracked)
  ✓ No BOM entries reference deleted schematic components
  ✓ tscircuit/core and easyeda-converter are installed
  ✓ LLM API key is configured and valid
  ✓ Cached datasheets and footprints are up to date
```

---

## Implementation Stack

```
Runtime:       Bun (fast, native TS, good for CLI tooling)
CLI framework: @clack/prompts (pretty interactive prompts)
               or Commander.js + Ink (React for CLI, pairs with tscircuit's React model)
Validation:    Zod (shared with tscircuit ecosystem)
KiCad bridge:  kicad-converter (parse/serialize .kicad_sch, .kicad_pcb, .kicad_mod)
               kicad-cli (export SVGs, Gerbers, run DRC — invoked as subprocess)
               kicad-python via IPC socket (live interaction, optional)
Parts search:  easyeda-converter (LCSC/JLC component API)
               octopart API or Nexar (DigiKey/Mouser aggregation)
LLM:           @anthropic-ai/sdk, @google/generative-ai
Subcircuits:   @tscircuit/core (compile TSX → Circuit JSON)
               @tscircuit/kicad-converter (Circuit JSON → KiCad files)
Config:        @iarna/toml (parse/serialize TOML)
```

---

## Serialization Design Decisions

### Why JSON for BOM/production, TOML for config

| Concern             | TOML                  | JSON                     | Protobuf              |
|---------------------|-----------------------|--------------------------|-----------------------|
| Human editing       | Excellent             | Okay (verbose)           | Terrible              |
| Git diffs           | Excellent             | Good                     | Terrible              |
| LLM generation      | Good                  | Excellent                | Poor                  |
| Nested structures   | Awkward (deep nesting)| Natural                  | Natural               |
| Schema validation   | Manual                | Zod                      | Built-in              |
| Array of objects     | Verbose ([[entries]]) | Natural                  | Natural               |
| Tool ecosystem      | Thin                  | Universal                | Requires codegen      |

TOML is perfect for `pcbpal.toml` — it's flat-ish config you'll hand-edit occasionally.
JSON is better for `pcbpal.bom.json` and `pcbpal.production.json` — they have deep
nesting and arrays of structured objects. Protobuf would only make sense if pcbpal
had a daemon/server component; for file-based storage it adds friction with no benefit.

### Why Zod and not JSON Schema

Zod schemas serve triple duty:
1. **Validation** at runtime (parse BOM file, get typed result or clear error)
2. **TypeScript types** via `z.infer<>` (full IDE support, no separate type defs)
3. **Documentation** via `z.describe()` (can auto-generate docs and LLM context)

JSON Schema would require separate type definitions and a validation library.
Zod is already the standard in the tscircuit ecosystem, so using it means pcbpal's
types are directly compatible with tscircuit/circuit-json types.

### Future: API / Daemon Mode

If pcbpal eventually grows a watch mode or web UI, the Zod schemas can generate
JSON Schema (via `zod-to-json-schema`) for OpenAPI definitions, or be used directly
in a tRPC server. The file-based format doesn't need to change.

If inter-process communication is needed (e.g., a pcbpal daemon that KiCad plugins
talk to), protobuf or JSON-RPC over a Unix socket would make sense for *that* channel,
but the project files would stay as JSON/TOML.
