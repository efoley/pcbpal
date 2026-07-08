/**
 * Sub-agent prompt templates for `datasheet extract --prepare`. Each
 * function renders the `instructions.md` a sub-agent reads alongside the
 * task package's page images and `schema.json`.
 *
 * These are consumed by an LLM, not a human — keep them terse and
 * imperative. See design-docs/datasheet_understanding_evals.md §4
 * (faithfulness mechanisms #1 schema-forced output with provenance, #5
 * enumerate-then-trace) and §5 (CLI surface / extract --prepare contract).
 */

export interface PromptContext {
  device: string;
  pages: number[];
  outputFile: string;
  validateCommand: string;
  pdfSha256: string;
}

function preamble(ctx: PromptContext): string {
  const pageList = ctx.pages.join(", ");
  return `# Datasheet extraction task

Device: ${ctx.device}
Datasheet pages included (absolute page numbers, use these — NOT the order
the images appear in): ${pageList}
Source PDF sha256: ${ctx.pdfSha256}

Read the page images in \`pages/\`. Fill in \`schema.json\` EXACTLY — it is the
Zod-derived JSON Schema for the output. Every top-level fact you extract must
carry provenance: \`{ page, label }\` where \`page\` is one of the ABSOLUTE page
numbers above (never a 1-based index into the image list) and \`label\` is the
table/figure name as printed ("Table 5", "Figure 12", "§6.3").

Never guess. Anything you cannot literally read:
- for specs: goes into \`not_found\` (name the section you looked for), not a
  fabricated value
- for anything with a \`confidence\` field: mark it \`"low"\` rather than
  inventing certainty
Do not invent values that "should" exist because they're typical for this
kind of part. Only report what is printed on the page.

Write your output to:

    ${ctx.outputFile}

Then run:

    ${ctx.validateCommand}

Fix EVERY error finding and re-run until the error list is empty. Warnings
deserve a second look against the page images, but a warning that's correct
after re-checking may stand — do not force a value change just to silence a
warning that reflects reality.
`;
}

/** Enumerate-then-trace prompting for the application/reference circuit facet. */
export function circuitPrompt(ctx: PromptContext): string {
  return `${preamble(ctx)}
## Facet: circuit (ReferenceCircuit)

This is the hard one. Do NOT try to describe the circuit in one pass — LLMs
are bad at circuit gestalt and good at exhaustive local reads. Work in three
phases, in order.

### Phase 1 — enumerate components

List every component symbol on the figure: its designator as printed (C1,
R2, L1, U1...), its kind, and its printed value (10µF, 100kΩ, ...) if shown.
State the total count out loud before moving on ("N = 7 components: C1, C2,
R1, R2, L1, D1, U1"). If the figure names a part number for any component
(e.g. an inductor MPN), record it in \`part\`.

### Phase 2 — trace every pin

For EACH component from Phase 1, for EACH of its pins: name every wire
endpoint the pin's wire touches. A connection target is either:
- another component's pin, written \`REF.PIN\` (e.g. \`C1.2\`, \`U1.5\`) — the
  \`.\` is what marks it as a pin reference, so never use \`.\` in a rail name
- a named rail exactly as printed in the figure (\`VIN\`, \`VOUT\`, \`GND\`,
  \`FB\`, ...) — no \`.\`
- the literal string \`"NC"\` for a pin that is genuinely unconnected (its own
  array, not mixed with other targets — a pin is either NC or connected,
  never both)

A pin with no wire at all is still a bug in your read, not a valid answer:
every real pin must resolve to at least one target or \`["NC"]\`. Follow the
actual wire/trace on the page — do not merge two nets just because their
wires pass close together or the routing is dense; only merge them if you
can trace a continuous connection or a labeled junction dot ties them.

### Phase 3 — junction dots and rails

List every rail name you used (VIN, VOUT, GND, FB, EN, ...) in \`rails\`.
Cross-check: every connection you stated should be visible from BOTH
endpoints — if C1.2 says it connects to R1.1, R1.1's own connects_to should
mention C1.2 (directly, or implicitly via sharing the same rail). The
validator flags connections that aren't reciprocated, so do this check
yourself before writing the file.

Set \`confidence\` for the whole circuit based on how legible the figure was —
\`"low"\` for a dense or low-resolution schematic you had to squint at.
Use \`notes\` for anything the datasheet says about component requirements
("C1 must be X7R", "L1 ≥ 2.2µH") — these are prose call-outs near the
figure, not part of the connectivity.
`;
}

/** Row-by-row extraction prompting for electrical spec tables. */
export function specsPrompt(ctx: PromptContext): string {
  return `${preamble(ctx)}
## Facet: specs (SpecTable)

Walk the cited table row by row, in the order it's printed. One \`SpecItem\`
per row. If a single row has multiple test-condition variants (e.g. separate
columns/rows for VIN=5V and VIN=12V of the same parameter), emit one
\`SpecItem\` per condition variant — do not collapse them into one item.

For each row:
- \`min\` / \`typ\` / \`max\` are separate numeric fields — never fold a
  condition into one of these fields, and never put a value where the table
  has no entry (leave it \`undefined\`, don't default to 0)
- \`conditions\` holds the test conditions verbatim, e.g. \`"VIN=5V, IOUT=1A,
  TA=25°C"\` — copy them as printed, don't paraphrase
- \`unit\` is the normalized plain symbol (\`V\`, \`mA\`, \`µH\`, \`MHz\`, \`°C\`) but
  do NOT convert the printed value between prefixes. If the table says
  "2.2 mH", record \`typ: 2.2, unit: "mH"\` — never silently rescale to µH or
  any other prefix. The number you write must match the printed number.
- \`symbol\` is the printed symbol (VIN, IQ, ...) if the table has one
- every item needs \`provenance\` pointing at this table (page + "Table N")
  and a \`confidence\`

\`section\` is one of absolute_maximum / recommended_operating /
electrical_characteristics / thermal / other — pick the one matching the
table you were given.

Before finishing, check \`not_found\`: for standard sections you looked for on
these pages and the datasheet does not have (e.g. no thermal table present),
list them by name. Do not leave \`not_found\` empty just because it's easier —
an honest "not present" is exactly what this field is for.
`;
}

/** Row-by-row extraction prompting for pin tables. */
export function pinsPrompt(ctx: PromptContext): string {
  return `${preamble(ctx)}
## Facet: pins (PinTable)

One \`PinEntry\` per physical pin, including the exposed pad (EP) if the
package has one — use \`number: "EP"\` for it. \`pin_count\` is the package's
total pin count (matches \`pins.length\`, EP included if present).

For each pin:
- \`number\` exactly as printed: \`"1"\`, \`"A3"\` for BGA, \`"EP"\` for the pad
- \`name\` exactly as printed, including overbars/slashes rendered as plain
  text the way the datasheet's own text would read aloud — \`"NRST"\` or
  \`"RESET#"\` for an active-low reset, \`"EN#"\` for active-low enable, not a
  literal overline character
- \`type\`: use the datasheet's own pin-type column/legend when the table has
  one (power_in / power_out / input / output / bidirectional / analog /
  passive / nc / other). If there's no explicit type column, map
  conservatively from the pin's described function — do not guess a
  specific type you can't justify from the text; \`"other"\` beats a
  confident wrong guess.
- \`description\` — the datasheet's own description text for the pin, if any
- \`provenance\` — page + "Table N" / "Figure N" for the pinout source

\`package\` is the package name as printed ("SOT-23-5", "QFN-32", ...). Get
this right — the validator checks that \`pin_count\` is plausible for the
named package.
`;
}
