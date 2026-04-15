# Proposal: `pcbpal firmware-datasheet`

Notes on a proposed pcbpal command for generating a firmware-oriented board
description (e.g. a `firmware_CLAUDE.md`) from a KiCad project plus the pcbpal
BOM. Written after hand-generating one for the curve-tracer board and noting
where the work was mechanical.

## Why this fits pcbpal

The task — "give me a doc describing the board for a firmware engineer" — is
a great fit for pcbpal because:

- pcbpal already knows what each part is *for* (the BOM `role` field).
- KiCad / the netlist already knows what each pin is *connected to*.
- The hard part is **joining those two**, and pcbpal is well-positioned to do
  it. No other tool in the workflow has both halves.

## Proposed command

```bash
pcbpal firmware-datasheet                    # writes firmware_CLAUDE.md
pcbpal firmware-datasheet --mcu U2           # if multiple MCUs, pick one
pcbpal firmware-datasheet --format markdown  # default; also json for tooling
pcbpal firmware-datasheet --include-tps      # include test point net mapping
```

## What it should do (in order)

1. **Run `kicad-cli sch export netlist`** under the hood. This gives the
   authoritative pin-to-net mapping — no LLM guessing needed. (This is what
   saved me when generating the curve-tracer doc; an inferred pin map had
   errors that the netlist corrected.)
2. **Auto-detect the MCU.** Look for a part whose `category=ic` and whose
   datasheet/MPN matches a known MCU family (STM32, RP2040, ESP32, etc.). If
   multiple, ask via `--mcu`.
3. **Emit a per-pin table** with: pin number, pin function (PA0, etc.),
   connected net, and a short purpose annotation. Pull the purpose from the
   BOM `role` of the part on the other end of the net (e.g. net `VREF`
   connects to U1 whose role is "3.0V voltage reference for ADC" → annotate
   `VREF` accordingly).
4. **Group nets by subsystem** using the hierarchical sheet they live in
   (`/Analog/`, `/USB/`, `/Power/`). Sheet names already give you free
   organization.
5. **List free GPIOs** explicitly (anything that resolves to
   `unconnected-(...)` in the netlist). Firmware folks always want this.
6. **Power rails section** — derived from BOM entries with `category=power`,
   listing input/output voltage and what they feed (from net membership).
7. **Debug connector section** — auto-detected from any part with `SWD`,
   `JTAG`, or `Tag-Connect` in its description.

## Why this beats hand-writing it

- The pin map is the most error-prone part to write by hand and the most
  mechanical to extract — perfect automation target.
- pcbpal already validates the BOM with Zod, so it can warn ("MCU has no role
  assigned, please add one before generating firmware doc").
- It enforces a consistent doc format across projects — a firmware engineer
  who has seen one pcbpal-generated `firmware_CLAUDE.md` knows exactly where
  to look in the next one.

## Smaller features that would have helped along the way

These are useful in their own right and would also be the building blocks for
`firmware-datasheet`:

- **`pcbpal net show <netname>`** — print every pin connected to a net, with
  each part's role. Useful for confirming things like "is `STATUS_LED` really
  driven by PB7 active-high?"
- **`pcbpal pin show U2`** — dump the full pin map for a single component.
  Sub-feature of the above.
- **`pcbpal sheet list`** — list hierarchical sheets and the nets that live
  in each. Helps with the "group by subsystem" step.

## One caveat: pin function knowledge

Pin *purpose* annotations (e.g. "DAC1_OUT1", "ADC1_IN5") require knowing the
MCU's pin functions — pcbpal would either need a small lookup of common MCUs
or to leave that section blank for the firmware Claude to fill in. The
schematic only knows "PA4 connects to SWEEP_CTL" — it doesn't know PA4 is a
DAC pin.

Options:

- **Punt it** — emit the net→pin table and let the firmware engineer (or
  their LLM) cross-reference the MCU datasheet.
- **Vendor pinout DB** — bundle a small JSON of pin-function tables for
  common MCU families (STM32, RP2040, ESP32, NRF52). Tedious to maintain but
  high value for the most common parts.
- **Read CubeMX `.ioc` files** — if the firmware engineer has already started
  a CubeMX project, the `.ioc` is a perfect input. pcbpal could even
  *generate* an `.ioc` from the netlist + role annotations.

The minimum viable command can punt and still be a huge improvement over
hand-writing the doc.
