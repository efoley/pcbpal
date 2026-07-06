import { z } from "zod";

// ── Provenance ──

export const Provenance = z.object({
  page: z.number().int().positive(),
  label: z.string(), // "Table 5", "Figure 12", "§6.3"
  note: z.string().optional(), // free-text locator, e.g. "third row"
});

export type Provenance = z.infer<typeof Provenance>;

// ── Specs ──

export const SpecValue = z.object({
  min: z.number().optional(),
  typ: z.number().optional(),
  max: z.number().optional(),
  unit: z.string(), // normalized: "V", "mA", "µH", "MHz", "°C"
  conditions: z.string().optional(), // "VIN=5V, IOUT=1A, TA=25°C"
});

export type SpecValue = z.infer<typeof SpecValue>;

export const SpecItem = z.object({
  parameter: z.string(), // "Input voltage", "Quiescent current"
  symbol: z.string().optional(), // "VIN", "IQ"
  value: SpecValue,
  provenance: Provenance,
  confidence: z.enum(["high", "medium", "low"]),
});

export type SpecItem = z.infer<typeof SpecItem>;

export const SpecTable = z.object({
  device: z.string(), // MPN as printed on the datasheet
  section: z.enum([
    "absolute_maximum",
    "recommended_operating",
    "electrical_characteristics",
    "thermal",
    "other",
  ]),
  items: z.array(SpecItem),
  not_found: z.array(z.string()).default([]), // facets searched but absent
});

export type SpecTable = z.infer<typeof SpecTable>;

// ── Pins ──

export const PinEntry = z.object({
  number: z.string(), // "1", "A3" (BGA), "EP" (exposed pad)
  name: z.string(), // "PA5", "VOUT", "NC"
  type: z.enum([
    "power_in",
    "power_out",
    "input",
    "output",
    "bidirectional",
    "analog",
    "passive",
    "nc",
    "other",
  ]),
  description: z.string().optional(),
  provenance: Provenance,
});

export type PinEntry = z.infer<typeof PinEntry>;

export const PinTable = z.object({
  device: z.string(),
  package: z.string(), // "SOT-23-5", "QFN-32"
  pin_count: z.number().int().positive(),
  pins: z.array(PinEntry),
});

export type PinTable = z.infer<typeof PinTable>;

// ── Reference circuit ──

export const RefCircuitComponent = z.object({
  designator: z.string(), // as printed in the figure: "C1", "R2", "L1"
  kind: z.enum([
    "resistor",
    "capacitor",
    "inductor",
    "diode",
    "led",
    "transistor",
    "ic",
    "crystal",
    "connector",
    "ferrite",
    "other",
  ]),
  value: z.string().optional(), // "10µF", "100kΩ", as printed
  part: z.string().optional(), // MPN if the figure names one
  pins: z.array(
    z.object({
      pin: z.string(), // "1", "2", "A", "K", "GATE"
      connects_to: z.array(z.string()), // "C1.2", "GND", "VIN" — pin refs or
      // named rails appearing in the figure
    }),
  ),
});

export type RefCircuitComponent = z.infer<typeof RefCircuitComponent>;

export const ReferenceCircuit = z.object({
  device: z.string(),
  title: z.string(), // figure caption
  provenance: Provenance,
  components: z.array(RefCircuitComponent),
  rails: z.array(z.string()), // named nets: "VIN", "VOUT", "GND"
  notes: z.array(z.string()).default([]), // "C1 must be X7R", "L1 ≥ 2.2µH"
  confidence: z.enum(["high", "medium", "low"]),
});

export type ReferenceCircuit = z.infer<typeof ReferenceCircuit>;

// ── Extraction file envelope ──

const ExtractorMeta = z.object({
  strategy: z.string(),
  model: z.string(),
});

export const DatasheetExtraction = z.discriminatedUnion("facet", [
  z.object({
    schema_version: z.literal(1),
    facet: z.literal("specs"),
    device: z.string(),
    pdf_sha256: z.string().optional(),
    extractor: ExtractorMeta.optional(),
    extracted_at: z.string().datetime().optional(),
    payload: SpecTable,
  }),
  z.object({
    schema_version: z.literal(1),
    facet: z.literal("pins"),
    device: z.string(),
    pdf_sha256: z.string().optional(),
    extractor: ExtractorMeta.optional(),
    extracted_at: z.string().datetime().optional(),
    payload: PinTable,
  }),
  z.object({
    schema_version: z.literal(1),
    facet: z.literal("circuit"),
    device: z.string(),
    pdf_sha256: z.string().optional(),
    extractor: ExtractorMeta.optional(),
    extracted_at: z.string().datetime().optional(),
    payload: ReferenceCircuit,
  }),
]);

export type DatasheetExtraction = z.infer<typeof DatasheetExtraction>;
