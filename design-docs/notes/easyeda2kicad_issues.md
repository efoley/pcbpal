# easyeda2kicad issues and workarounds

## User-Agent blocked by CloudFront (critical)

The EasyEDA API (`/api/products/{id}/components?version=6.4.19.5`) returns
403 when the User-Agent is `easyeda2kicad v0.8.0`. CloudFront blocks it.
Changing to a browser-like UA fixes it. This completely blocks `pcbpal lib fetch`.

**Current workaround:** Manually patch the installed easyeda2kicad to use
a browser-like User-Agent string.

**Future fix options:**
1. Fork easyeda2kicad with UA fix
2. Set environment variable / wrapper to override UA before spawning
3. Use pcbpal's own HTTP client to fetch EasyEDA data and pass to converter

## Symbol file format is KiCad 6 vintage

easyeda2kicad produces `.kicad_sym` files with:
- `(version 20211014)` — KiCad 6 format
- Missing `exclude_from_sim` field (required in KiCad 9)
- Missing `generator_version` field
- Space-based indentation instead of tabs

KiCad 9's symbol chooser shows these libraries as **empty** even though
`kicad-cli sym export svg` can render the symbols fine. The symbols are
parseable but not browsable in the GUI.

**Workaround:** Run `kicad-cli sym upgrade --force` on the merged symbol
file to convert it to KiCad 9 format. pcbpal's `lib install` does this
automatically as a post-processing step.

## Error handling is poor

When easyeda2kicad crashes (e.g., JSONDecodeError from an empty API
response), it dumps a Python traceback. pcbpal just forwards this as an
error message. Better to:
- Catch specific errors and print clear messages
- Detect 403 responses and suggest the UA workaround
- Handle "already exists" (exit code 1 with WARNING) gracefully

## Library naming is opaque

Fetched libraries are named by LCSC number (e.g., `C488349.kicad_sym`).
In KiCad's symbol chooser this is meaningless — you have to remember that
C488349 is the IP5306-I2C. The symbol's Value property has the real name,
but the library-level naming gives no hint.

pcbpal works around this by merging all symbols into a single `pcbpal.kicad_sym`
library, so the chooser shows `pcbpal > IP5306-I2C` instead of `C488349 > IP5306-I2C`.

## Footprint property references are per-component

Each symbol's Footprint property references its own LCSC-named library:
`C173752:CONN-TH_S2B-PH-K-S-LF-SN`. This breaks when symbols are merged
into a single library. pcbpal's `lib install` rewrites these to
`pcbpal:CONN-TH_S2B-PH-K-S-LF-SN` during the merge.
