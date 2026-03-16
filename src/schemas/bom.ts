import { z } from "zod";

export const PartSource = z.object({
  supplier: z.enum(["lcsc", "digikey", "mouser", "manual"]),
  part_number: z.string(),
  url: z.string().url().optional(),
  unit_price_usd: z.number().optional(),
  stock: z.number().int().optional(),
  last_checked: z.string().datetime().optional(),
});

export type PartSource = z.infer<typeof PartSource>;

export const PartConstraints = z.object({
  parameters: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.number(),
        z.object({
          min: z.number().optional(),
          nom: z.number().optional(),
          max: z.number().optional(),
          unit: z.string(),
        }),
      ]),
    )
    .optional(),
  package: z.string().optional(),
  footprint_ref: z.string().optional(),
  impedance: z
    .object({
      target_ohms: z.number(),
      tolerance_pct: z.number().optional(),
      frequency_hz: z.number().optional(),
    })
    .optional(),
});

export type PartConstraints = z.infer<typeof PartConstraints>;

export const BomCategory = z.enum([
  "ic",
  "passive",
  "connector",
  "antenna",
  "crystal",
  "inductor",
  "diode",
  "led",
  "transistor",
  "sensor",
  "power",
  "mechanical",
  "other",
]);

export type BomCategory = z.infer<typeof BomCategory>;

export const BomStatus = z.enum(["candidate", "selected", "ordered", "verified"]);

export type BomStatus = z.infer<typeof BomStatus>;

export const BomEntry = z.object({
  id: z.string().uuid(),
  role: z.string(),
  description: z.string().optional(),
  category: BomCategory,
  manufacturer: z.string().optional(),
  mpn: z.string().optional(),
  sources: z.array(PartSource).default([]),
  constraints: PartConstraints.optional(),
  selection_notes: z.string().optional(),
  datasheet_url: z.string().url().optional(),
  notes: z.string().optional(),
  kicad_refs: z.array(z.string()).default([]),
  kicad_symbol: z.string().optional(),
  kicad_footprint: z.string().optional(),
  subcircuit: z.string().optional(),
  alternates: z
    .array(
      z.object({
        mpn: z.string(),
        source: PartSource.optional(),
        why_not: z.string().optional(),
      }),
    )
    .default([]),
  status: BomStatus.default("candidate"),
  added: z.string().datetime(),
  updated: z.string().datetime(),
});

export type BomEntry = z.infer<typeof BomEntry>;

export const BomDatabase = z.object({
  schema_version: z.literal(1),
  entries: z.array(BomEntry),
});

export type BomDatabase = z.infer<typeof BomDatabase>;
