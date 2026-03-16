# pcbpal usage

## Setup

```bash
bun install
```

## Commands

All commands support `--json` for structured output.

### Initialize a project

```bash
pcbpal init                          # scan for .kicad_pro, create config files
pcbpal init --kicad-project foo.kicad_pro
pcbpal init --no-git                 # skip .gitignore creation
```

Creates: `pcbpal.toml`, `pcbpal.bom.json`, `pcbpal.production.json`, `.pcbpal/`

### Search for components

```bash
pcbpal search "100nF 0402 X7R"
pcbpal search "nRF52832 QFN" --limit 10
pcbpal search "chip antenna 2.4GHz" --in-stock
pcbpal search "10k 0402" --max-price 0.01
pcbpal search --lcsc C1525            # lookup by LCSC part number
```

### Manage BOM

```bash
pcbpal bom show                       # display all entries
pcbpal bom show --category passive    # filter by category
pcbpal bom show --status selected     # filter by status

# Add with manual details
pcbpal bom add --role "BLE antenna" --category antenna --mpn "2450AT18B100E"

# Add with LCSC auto-populate (fetches MPN, manufacturer, description, datasheet, price)
pcbpal bom add --role "Decoupling cap" --category passive --lcsc C1525 --refs "C1"

pcbpal bom remove <id-or-prefix>      # remove by UUID or prefix
pcbpal bom link <id-or-prefix> C12,C13  # link to KiCad reference designators
```

Categories: `ic`, `passive`, `connector`, `antenna`, `crystal`, `inductor`, `diode`, `led`, `transistor`, `sensor`, `power`, `mechanical`, `other`

### Fetch symbol/footprint

```bash
pcbpal lib fetch C1525                # download from EasyEDA into .pcbpal/
```

### Health check

```bash
pcbpal doctor                         # validate project files, check kicad-cli
```

## Running during development

```bash
bun run src/cli/index.ts <command>    # run directly
bun run typecheck                     # type check
bun test                              # run tests
```
