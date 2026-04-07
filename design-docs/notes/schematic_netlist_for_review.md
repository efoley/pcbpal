# Schematic netlist for LLM review

## Problem

LLMs (Claude, Gemini) are bad at reading circuit topology from schematic
images. They can identify individual components but can't reliably trace
nets. This limits the value of `pcbpal review schematic` — the exported
SVGs are useful for humans but an LLM can't reason about connectivity.

## Solution: text netlist alongside SVGs

`kicad-cli sch export netlist` already outputs full connectivity. Digest
it into a simple text format:

```
Net "NRST": U2.pin7, SW1.pin1, J1.pin3
Net "GND": U2.pin23, C1.pin2, C2.pin2, SW1.pin2, ...
Net "VCC": U2.pin1, R1.pin1, C1.pin1, ...
```

Include this in `review`'s `context.json` so the LLM can reason about
connections without parsing images. The SVGs still provide visual context
for layout/placement questions.

## Implementation

- Use `kicad-cli sch export netlist --format kicadxml` for structured output
- Parse the XML to extract net-to-pin mappings
- Add a `nets` field to `ReviewContextData`
- Include alongside existing `schematicComponents` and `images`

## PNG output for LLM vision

LLM vision APIs (Claude, Gemini) handle PNGs better than SVGs — some
don't support SVG at all. kicad-cli doesn't export PNG directly, so
the pipeline would be:

1. Export SVG via `kicad-cli sch export svg` / `pcb export svg`
2. Convert to PNG via `rsvg-convert` (from librsvg, lightweight) or
   `inkscape --export-type=png` (heavier but more accurate)
3. Output both SVG (for humans) and PNG (for LLMs)

`rsvg-convert` is the better choice — it's a small C tool usually
available as `librsvg2-bin` on Debian/Ubuntu. `pcbpal doctor` could
check for it.
