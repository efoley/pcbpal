# pcbpal

A command-line companion for KiCad PCB projects, designed to be used by
both humans and AI coding agents (Claude Code, Gemini CLI, etc.).

## What it does

pcbpal sits between you and KiCad. KiCad owns the schematics and layout;
pcbpal owns the *intent* layer: what parts you chose and why, what your
production constraints are, and how to turn a finished design into
fabrication files.

- **Search** LCSC/JLCPCB for components, check stock and pricing
- **Manage a BOM** with design-intent annotations (roles, selection notes, alternates)
- **Fetch symbols and footprints** from EasyEDA/LCSC into a merged KiCad library
- **Sync** the BOM with your KiCad schematic and JLCPCB plugin data
- **Check** your BOM against the schematic — stock, footprint matching, consistency
- **Export** JLCPCB-ready production files — gerbers, drill, BOM CSV, placement CSV
- **Generate** a firmware-oriented board reference from the netlist
- **Review** — assemble schematic SVGs, netlist data, and DRC results as a context
  package for AI-assisted design review

## Philosophy

pcbpal is a CLI tool.  Every command supports `--json` for structured output.

pcbpal doesn't try to replace KiCad or build its own LLM interface.
Instead, it prepares data (netlists, SVGs, BOM summaries) that your
preferred AI tool can reason about. pcbpal just provides boring plumbing
to make your coding agent work better while spending fewer tokens. 

## Install

Requires [Bun](https://bun.sh) and [KiCad 9+](https://www.kicad.org/).

```bash
git clone <repo-url> && cd pcbpal
bun install
bun link          # makes `pcbpal` available globally
```

For symbol/footprint fetching, also install:

```bash
pipx install easyeda2kicad
```

## Quick start

```bash
cd your-kicad-project/
pcbpal init                          # creates pcbpal.toml, BOM, production config, CLAUDE.md
pcbpal search "100nF 0402"           # search LCSC
pcbpal bom sync                      # populate BOM from schematic + JLCPCB plugin
pcbpal bom check                     # verify stock, footprints, consistency
pcbpal production export             # gerbers + BOM + CPL in one command
pcbpal firmware-datasheet            # generate firmware_CLAUDE.md from netlist
pcbpal doctor                        # check that everything is set up correctly
```

## Project files

| File | Purpose |
|------|---------|
| `pcbpal.toml` | Project config: name, KiCad project path, fab defaults |
| `pcbpal.bom.json` | Bill of materials with roles, sources, and refs |
| `pcbpal.production.json` | Board specs, stackup, placement corrections |
| `.pcbpal/` | Cache: fetched libraries, production output, review context |

## License

MIT
