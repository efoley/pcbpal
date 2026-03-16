# pcbpal CLI: Human vs LLM Agent Interactivity

## The Dual-Mode Problem

pcbpal is used in two distinct modes:

1. **Human-interactive** — a person at a terminal running `pcbpal search`,
   browsing results, picking options, seeing styled output.
2. **LLM-agent-driven** — Claude Code (or similar) shelling out to pcbpal,
   reading structured output, and making decisions programmatically.

These modes need different presentation but the same underlying logic. The
design principle: **every command has a non-interactive core that does the
work and returns a typed result, then a thin presentation layer that either
formats it for humans or serializes it as JSON.**

---

## Context Detection

Two signals determine the mode:

```typescript
// cli/context.ts
export function isInteractive(): boolean {
  return process.stdout.isTTY === true
    && !process.argv.includes("--json");
}

export function isJson(): boolean {
  return process.argv.includes("--json");
}
```

| Condition                        | Mode            | Behavior                          |
|----------------------------------|-----------------|-----------------------------------|
| TTY + no `--json`                | Interactive     | Styled output, prompts, spinners  |
| `--json` flag (regardless of TTY)| Batch/JSON      | Structured JSON to stdout         |
| No TTY (piped/captured)          | Batch/plain     | Plain text, no prompts, no color  |

Claude Code will typically see the batch mode because it captures stdout.
The `--json` flag is an explicit override for cases where someone is at a
TTY but wants machine-readable output (e.g. piping to `jq`).

---

## Architecture: Core / Presentation Split

Every command follows this pattern:

```
CLI argument parsing (commander/yargs)
  → Core function (async, no I/O, returns typed result)
    → Presentation layer (formats result for the detected mode)
```

The core function **never**:
- Prompts for input
- Writes to stdout/stderr
- Uses colors or spinners
- Calls `process.exit()`

The core function **always**:
- Takes fully-resolved options (no ambiguity)
- Returns a typed result object
- Throws typed errors for failure cases

Example:

```typescript
// commands/search/core.ts
export interface SearchOptions {
  query: string;
  supplier?: "lcsc" | "digikey" | "mouser";
  inStock?: boolean;
  maxPrice?: number;
  limit?: number;
}

export interface SearchResult {
  results: PartSearchHit[];
  total: number;
  query: string;
  supplier: string;
}

export async function searchParts(opts: SearchOptions): Promise<SearchResult> {
  // Pure logic: call APIs, filter, sort, return
  // No I/O, no prompts, no formatting
}


// commands/search/cli.ts
import { searchParts } from "./core";
import { isInteractive, isJson } from "../../cli/context";

export async function searchCommand(opts: SearchOptions) {
  const result = await runWithSpinner(
    () => searchParts(opts),
    "Searching...",  // only shown in interactive mode
  );

  if (isJson()) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Interactive: pretty table
  renderSearchTable(result);

  if (isInteractive()) {
    // Offer to add a result to BOM
    const selected = await clack.select({
      message: "Add to BOM?",
      options: result.results.map(r => ({
        value: r.lcsc,
        label: `${r.mpn} — ${r.description}`,
      })),
    });
    if (selected) {
      await addToBom({ lcsc: selected, /* ... */ });
    }
  }
}
```

---

## Interactive Components (Human Mode)

For human-interactive mode, use **@clack/prompts** for structured interactions
and **@clack/core** where finer control is needed. clack provides:

- `select` / `multiselect` — choosing from search results, stackup options
- `text` / `confirm` — entering part roles, confirming destructive actions
- `spinner` — long-running operations (API calls, compilation)
- `note` / `outro` — styled informational output

clack is used **only in the presentation layer**, never in core logic.

For tabular output (BOM listing, search results), use a lightweight table
formatter like `cli-table3` or just padded columns. Keep it simple — the
data is more important than the formatting.

**Don't use clack for:** argument parsing (use commander), progress bars on
file operations (just show the result), or anything that would block in a
pipeline.

---

## Batch/JSON Mode (LLM Agent)

When `--json` is active or the output is piped, every command must:

1. **Print exactly one JSON object to stdout** (for single results) or
   one JSON object per line (for streaming results, rare).

2. **Use stderr for progress/diagnostic messages** if needed. Claude Code
   and shell scripts ignore stderr by default when capturing stdout.

3. **Use exit codes consistently:**
   - `0` — success
   - `1` — command failed (invalid input, API error, etc.)
   - `2` — validation failed (build errors, DRC violations, etc.)

4. **Include enough context in the JSON for the agent to act on:**

```jsonc
// pcbpal sub build antenna-match --json
{
  "ok": false,
  "subcircuit": "antenna-match",
  "source": "subcircuits/antenna-match.tsx",
  "components": 4,
  "nets": 3,
  "errors": [
    {
      "type": "compile_error",
      "message": "Pin 'pin3' does not exist on component SW1 (2-pin footprint)",
      "line": 14,
      "column": 5
    }
  ],
  "warnings": []
}
```

```jsonc
// pcbpal search "10pF 0402 C0G" --json
{
  "query": "10pF 0402 C0G",
  "supplier": "lcsc",
  "total": 47,
  "results": [
    {
      "lcsc": "C123456",
      "mpn": "GRM1555C1H100JA01D",
      "manufacturer": "Murata",
      "description": "10pF ±5% 50V C0G 0402",
      "package": "0402",
      "stock": 284000,
      "unit_price_usd": 0.0023,
      "has_footprint": true,
      "has_symbol": true
    }
    // ...
  ]
}
```

```jsonc
// pcbpal bom show --json
{
  "schema_version": 1,
  "entries": [
    {
      "id": "a1b2c3d4-...",
      "role": "BLE chip antenna",
      "category": "antenna",
      "mpn": "2450AT18B100E",
      "manufacturer": "Johanson Technology",
      "sources": [{ "supplier": "lcsc", "part_number": "C123456" }],
      "kicad_refs": ["ANT1"],
      "status": "selected",
      "notes": "Place within 3mm of U1 pin 32, ground stitch vias around"
    }
    // ...
  ]
}
```

---

## Commands by Interaction Pattern

### Always non-interactive (pure batch)
These commands do a single thing and report the result. They should never
prompt, even in interactive mode.

- `pcbpal sub build <name>` — compile and validate
- `pcbpal sub preview <name>` — render to file, print path
- `pcbpal sub export <name>` — export to KiCad
- `pcbpal doctor` — health check
- `pcbpal bom cost` — calculate costs
- `pcbpal production check` — validate design rules
- `pcbpal review --prepare-only` — assemble context package

### Interactive when human, batch when `--json`
These commands have optional interactive elements for human convenience.

- `pcbpal search` — interactive: offer to add result to BOM
- `pcbpal bom add` — interactive: prompt for missing fields (role, refs)
- `pcbpal bom sync` — interactive: confirm each unmatched component
- `pcbpal init` — interactive: confirm settings before writing files
- `pcbpal production stackup` — interactive: select from available stackups
- `pcbpal lib fetch` — interactive: show footprint preview, confirm

### Interactive-only (human use)
These inherently need a human in the loop. Claude Code wouldn't call these
directly — it would use the underlying non-interactive commands instead.

- `pcbpal review` (without `--prepare-only`) — streams LLM response to terminal
- `pcbpal config` (without arguments) — opens interactive config editor

---

## Helper Utilities

```typescript
// cli/output.ts

/**
 * Run an async operation with a spinner in interactive mode,
 * silently in batch mode.
 */
export async function runWithSpinner<T>(
  fn: () => Promise<T>,
  message: string,
): Promise<T> {
  if (isInteractive()) {
    const s = clack.spinner();
    s.start(message);
    try {
      const result = await fn();
      s.stop("Done");
      return result;
    } catch (e) {
      s.stop("Failed");
      throw e;
    }
  }
  return fn();
}

/**
 * Output a result in the appropriate format.
 * In JSON mode: serialize to stdout.
 * In interactive mode: call the provided render function.
 */
export function output<T>(
  result: T,
  render: (result: T) => void,
): void {
  if (isJson()) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    render(result);
  }
}

/**
 * Report an error and exit.
 * In JSON mode: structured error object.
 * In interactive mode: styled error message.
 */
export function fatal(message: string, details?: object): never {
  if (isJson()) {
    console.log(JSON.stringify({ ok: false, error: message, ...details }));
  } else {
    clack.log.error(message);
    if (details) console.error(details);
  }
  process.exit(1);
}
```

---

## Claude Code Integration: CLAUDE.md

Rather than an MCP server, the primary LLM integration is a `CLAUDE.md` file
in the project root (or a pcbpal-provided snippet for it) that teaches Claude
Code how to use pcbpal. This is more effective than MCP for Claude Code
specifically, because it's just natural language instructions that Claude Code
reads on startup.

Example CLAUDE.md section:

```markdown
## pcbpal

This project uses pcbpal for BOM management, subcircuit templating, and
production configuration. pcbpal files live alongside the KiCad project.

### Key commands (always use --json for structured output):

- `pcbpal search "<query>" --json` — search LCSC for components
- `pcbpal bom show --json` — view current BOM
- `pcbpal bom add --lcsc <part#> --role "<role>" --refs "<refs>" --json` — add to BOM
- `pcbpal lib fetch <lcsc#> --json` — download symbol + footprint from LCSC
- `pcbpal sub build <name> --json` — compile a subcircuit TSX, check for errors
- `pcbpal sub preview <name> --format svg --output <path>` — render schematic SVG
- `pcbpal sub export <name> --to kicad --json` — export to KiCad hierarchical sheet
- `pcbpal production impedance --type gcpw --target 50 --json` — calculate trace geometry
- `pcbpal review schematic --prepare-only --json` — export review context package
- `pcbpal doctor --json` — check project health

### Subcircuit workflow:
1. Edit the TSX file in subcircuits/<name>.tsx directly
2. Run `pcbpal sub build <name> --json` to validate
3. If errors, fix the TSX and rebuild
4. Run `pcbpal sub preview <name>` to render a visual check
5. Run `pcbpal sub export <name> --to kicad` when ready

### Files:
- pcbpal.toml — project config (rarely needs editing)
- pcbpal.bom.json — BOM database (use `pcbpal bom` commands to manage)
- pcbpal.production.json — fabrication config (use `pcbpal production` commands)
- subcircuits/*.tsx — tscircuit subcircuit definitions (edit directly)
```

---

## Recommended Implementation Stack

```
Argument parsing:    Commander.js
                     (simple, widely used, good subcommand support,
                     doesn't impose opinions on output formatting)

Interactive prompts: @clack/prompts
                     (used only in presentation layer, only when isInteractive())

Table formatting:    cli-table3 or columnify
                     (for human-readable BOM/search tables)

Colors:              picocolors
                     (tiny, auto-detects NO_COLOR and piped output)

JSON output:         native JSON.stringify
                     (no library needed)
```

Avoid Ink (React for CLI) — it's powerful but heavyweight and would add
complexity for rendering that doesn't justify it here. The interactive
elements are simple enough for clack, and the rest is just formatted text.
