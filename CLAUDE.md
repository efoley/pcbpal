# CLAUDE.md — pcbpal

## What is pcbpal?

pcbpal is a CLI companion tool for PCB design. It manages BOM (bill of
materials), searches component suppliers (LCSC), fetches symbols/footprints,
configures production settings (stackups, impedance), and exports
fabrication-ready packages. It works alongside KiCad — pcbpal owns the
intent layer (what parts, why, production constraints), KiCad owns the
implementation (schematics, layout, copper).

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict mode)
- **CLI framework:** Commander.js for argument parsing
- **Interactive prompts:** @clack/prompts (only when stdout is TTY and --json is not set)
- **Validation:** Zod for all schemas
- **Config:** TOML for pcbpal.toml (use @iarna/toml), JSON for bom and production files
- **Testing:** bun test
- **Package manager:** bun

## Project Structure

```
pcbpal/
├── src/
│   ├── cli/
│   │   ├── index.ts              # Entry point, commander setup
│   │   ├── context.ts            # isInteractive(), isJson() helpers
│   │   └── output.ts             # output(), fatal(), runWithSpinner() helpers
│   ├── commands/
│   │   ├── init/
│   │   │   ├── core.ts           # Logic (no I/O)
│   │   │   └── cli.ts            # Presentation layer
│   │   ├── search/
│   │   │   ├── core.ts
│   │   │   └── cli.ts
│   │   ├── bom/
│   │   │   ├── core.ts
│   │   │   └── cli.ts
│   │   ├── lib/
│   │   │   ├── core.ts
│   │   │   └── cli.ts
│   │   ├── doctor/
│   │   │   ├── core.ts
│   │   │   └── cli.ts
│   │   ├── production/
│   │   │   ├── core.ts
│   │   │   └── cli.ts
│   │   ├── review/
│   │   │   ├── core.ts
│   │   │   └── cli.ts
│   │   └── sub/
│   │       ├── core.ts
│   │       └── cli.ts
│   ├── schemas/
│   │   ├── bom.ts                # BomEntry, BomDatabase, PartSource, etc.
│   │   ├── production.ts         # FabStackup, ControlledImpedance, ProductionConfig
│   │   ├── config.ts             # ProjectConfig (pcbpal.toml shape)
│   │   └── index.ts              # Re-exports
│   ├── services/
│   │   ├── lcsc.ts               # LCSC/EasyEDA API client
│   │   ├── kicad.ts              # KiCad file reading, kicad-cli wrapper
│   │   └── project.ts            # Read/write pcbpal project files from disk
│   └── util/
│       └── ...
├── data/
│   └── stackups/
│       └── jlcpcb.json           # JLCPCB stackup database
├── design-docs/                  # Design documents (see below)
│   ├── README.md
│   ├── pcbpal-design.md
│   └── cli_human_vs_llm.md
├── CLAUDE.md                     # This file
├── package.json
├── tsconfig.json
└── bunfig.toml
```

## Critical Architecture Rule: Core / Presentation Split

Every command is split into two files:

**core.ts** — Pure logic. Takes typed options, returns typed results.
- NEVER prompts for input
- NEVER writes to stdout/stderr
- NEVER uses colors, spinners, or formatting
- NEVER calls process.exit()
- Always returns a typed result object or throws a typed error

**cli.ts** — Presentation layer. Registers the commander subcommand, calls
core, formats output.
- Checks `isInteractive()` and `isJson()` from `src/cli/context.ts`
- In JSON mode: `console.log(JSON.stringify(result, null, 2))`
- In interactive mode: styled output with clack, tables, prompts
- In plain mode (piped, no TTY): unformatted text

```typescript
// Example pattern — every command follows this
// commands/search/core.ts
export interface SearchOptions { query: string; supplier?: string; /* ... */ }
export interface SearchResult { results: PartHit[]; total: number; }
export async function searchParts(opts: SearchOptions): Promise<SearchResult> {
  // pure logic, no I/O
}

// commands/search/cli.ts
import { searchParts } from "./core";
import { output, runWithSpinner } from "../../cli/output";
export function registerSearchCommand(program: Command) {
  program.command("search <query>")
    .option("--supplier <s>", "lcsc, digikey, mouser")
    .option("--in-stock", "only in-stock parts")
    .action(async (query, opts) => {
      const result = await runWithSpinner(
        () => searchParts({ query, ...opts }),
        "Searching..."
      );
      output(result, renderSearchTable);
    });
}
```

## Global --json Flag

Every command supports `--json`. This is registered once at the program level
in `src/cli/index.ts`. When set, all output is structured JSON to stdout.
Errors are also JSON: `{ "ok": false, "error": "message" }`. Exit code 0
for success, 1 for errors, 2 for validation failures.

## Schemas

All data schemas live in `src/schemas/` and use Zod. The schemas define both
the validation logic and the TypeScript types (via `z.infer<>`). The three
main schemas are:

1. **BomDatabase** (`bom.ts`) — array of BomEntry objects. Each entry tracks
   a component's role, part selection, sources, constraints, notes, KiCad
   reference designators, and lifecycle status.

2. **ProductionConfig** (`production.ts`) — board specs, FabStackup (references
   a fab house's named stackup ID, with auto-populated layer details),
   controlled impedance profiles, fabrication and assembly settings.

3. **ProjectConfig** (`config.ts`) — parsed from pcbpal.toml. Project name,
   KiCad project path, library paths, LLM settings, default fab house.

Refer to `design-docs/pcbpal-design.md` for the full schema definitions.

## Implementation Phases

### Phase 1 (current): Search + BOM
Build these commands first, in this order:

1. **Scaffolding** — project structure, CLI entry point with commander,
   context/output helpers, schema files. `pcbpal --help` should work.

2. **`pcbpal init`** — scan for .kicad_pro, create pcbpal.toml + empty
   pcbpal.bom.json + pcbpal.production.json + .pcbpal/ + .gitignore.

3. **`pcbpal search`** — hit the LCSC/EasyEDA API, return structured results.
   The LCSC API is undocumented but the tscircuit easyeda-converter package
   has working API calls to reverse-engineered endpoints. Study how
   `fetchEasyEDAComponent` works in that package. We may want to call those
   endpoints directly rather than depending on the npm package, so we control
   the interface.

4. **`pcbpal bom add/show/remove/link`** — CRUD on pcbpal.bom.json. Validate
   with Zod on every read/write. `bom add --lcsc C123456` should auto-populate
   manufacturer, MPN, description, and datasheet URL from the LCSC API.

5. **`pcbpal lib fetch`** — download KiCad symbol (.kicad_sym) and footprint
   (.kicad_mod) for an LCSC part. Store in .pcbpal/symbols/ and
   .pcbpal/footprints/. The easyeda-converter package can convert EasyEDA
   JSON to KiCad formats.

6. **`pcbpal doctor`** — verify KiCad project exists, pcbpal files parse
   correctly, all BOM entries have valid footprints, etc.

### Phase 2: Production + Review
After Phase 1 is working. See design docs for details.

### Phase 3: Subcircuits (tscircuit integration)
Most speculative. Defer until Phases 1-2 are proven.

## LCSC / EasyEDA API Notes

The LCSC component API is not officially documented. Key endpoints used by
the tscircuit easyeda-converter:

- Component search: `https://jlcpcb.com/api/searchComponent/list` (POST)
- Component detail: fetches EasyEDA JSON which contains schematic symbol
  and PCB footprint data encoded as strings

Study the `fetchEasyEDAComponent` function in the tscircuit/easyeda-converter
repo to understand the API contract. Consider extracting the API client logic
into our own service (`src/services/lcsc.ts`) rather than importing the full
package, since we may want to add caching, rate limiting, and error handling
specific to pcbpal's needs.

## Style Guidelines

- Use async/await, not callbacks or raw promises
- Prefer explicit types over inference for function signatures
- Error handling: throw typed errors from core, catch and format in cli
- No classes unless genuinely needed; prefer plain functions + interfaces
- Keep files small — if a core.ts exceeds ~200 lines, split by subcommand
- Tests go next to source files: `core.test.ts` alongside `core.ts`

## Design Documents

The `design-docs/` directory contains detailed design documents:

- `README.md` — index of all docs and implementation priorities
- `pcbpal-design.md` — full schema definitions, CLI command reference,
  architecture overview
- `cli_human_vs_llm.md` — how the CLI handles human vs LLM agent usage,
  core/presentation split pattern, JSON output contracts

**Read these before implementing.** They contain the Zod schema definitions
to use, the exact CLI command signatures, and the rationale for design
decisions.
