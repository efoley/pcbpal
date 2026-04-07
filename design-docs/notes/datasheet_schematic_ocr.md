# Datasheet schematic OCR → netlist

## Problem

Datasheets contain reference/application circuits as images. Extracting
these into structured netlists would enable:
- "Turn the datasheet's recommended circuit into a tscircuit subcircuit"
- "Verify my schematic matches the datasheet's reference design"
- Auto-populating component values from reference designs

## Approach

Use LLM vision with structured output rather than traditional OCR. The
LLM is bad at *implicitly* reading topology from images, but may do much
better with explicit prompting:

1. Extract the schematic image from the PDF (specific page/region)
2. Prompt the LLM to enumerate every component and trace every wire
   into a fixed schema (component list + net connections)
3. Output as Circuit JSON, tscircuit TSX, or simple netlist text

## Comparison mode

Pair the extracted datasheet netlist with the user's KiCad netlist (from
`kicad-cli sch export netlist`) to diff them — flag missing connections,
wrong values, extra components.

## Could be

- A `pcbpal` subcommand: `pcbpal review datasheet <pdf> --page 12`
- A standalone tool
- Part of the `review` context package (attach datasheet circuit as
  structured data alongside the user's schematic)
