import { z } from "zod";

export const StackupLayer = z.object({
  type: z.enum(["copper", "prepreg", "core", "soldermask", "silkscreen", "paste"]),
  name: z.string().optional(),
  thickness_mm: z.number(),
  copper_weight_oz: z.number().optional(),
  laminate_code: z.string().optional(),
  dielectric_constant: z.number().optional(),
  loss_tangent: z.number().optional(),
  resin_content_pct: z.number().optional(),
});

export type StackupLayer = z.infer<typeof StackupLayer>;

export const FabHouse = z.enum(["jlcpcb", "pcbway", "oshpark", "other"]);

export type FabHouse = z.infer<typeof FabHouse>;

export const FabStackup = z.object({
  fab_house: FabHouse,
  stackup_id: z.string(),
  layer_count: z.number().int(),
  total_thickness_mm: z.number(),
  layers: z.array(StackupLayer),
});

export type FabStackup = z.infer<typeof FabStackup>;

export const ControlledImpedance = z.object({
  name: z.string(),
  type: z.enum(["microstrip", "stripline", "coplanar", "gcpw"]),
  target_ohms: z.number(),
  tolerance_pct: z.number().default(10),
  trace_width_mm: z.number().optional(),
  gap_mm: z.number().optional(),
  signal_layer: z.string().optional(),
  reference_layer: z.string().optional(),
  net_classes: z.array(z.string()).default([]),
  notes: z.string().optional(),
  calculated: z
    .object({
      trace_width_mm: z.number(),
      gap_mm: z.number().optional(),
      impedance_ohms: z.number(),
      dk_used: z.number(),
      dielectric_height_mm: z.number(),
    })
    .optional(),
});

export type ControlledImpedance = z.infer<typeof ControlledImpedance>;

export const PlacementCorrection = z.object({
  /** Regex pattern to match against footprint name, reference, or value. */
  pattern: z.string(),
  /** What the pattern matches against. */
  match_on: z.enum(["footprint", "reference", "value"]).default("footprint"),
  /** Rotation correction in degrees (added to KiCad rotation). */
  rotation: z.number().default(0),
  /** X offset in mm. */
  offset_x: z.number().default(0),
  /** Y offset in mm. */
  offset_y: z.number().default(0),
});

export type PlacementCorrection = z.infer<typeof PlacementCorrection>;

export const ProductionConfig = z.object({
  schema_version: z.literal(1),
  board: z.object({
    thickness_mm: z.number().default(1.6),
    min_trace_mm: z.number().default(0.127),
    min_space_mm: z.number().default(0.127),
    min_drill_mm: z.number().default(0.3),
    min_via_diameter_mm: z.number().default(0.6),
    surface_finish: z.enum(["hasl", "enig", "osp", "immersion_silver"]).default("enig"),
  }),
  stackup: FabStackup.optional(),
  controlled_impedance: z.array(ControlledImpedance).default([]),
  fabrication: z.object({
    fab_house: FabHouse.default("jlcpcb"),
    quantity: z.number().int().default(5),
    panelization: z.boolean().default(false),
    notes: z.array(z.string()).default([]),
  }),
  assembly: z
    .object({
      assembly_house: z.enum(["jlcpcb", "pcbway", "manual", "other"]).default("jlcpcb"),
      sides: z.enum(["top", "bottom", "both"]).default("top"),
      manual_parts: z.array(z.string()).default([]),
    })
    .optional(),
  placement_corrections: z.array(PlacementCorrection).default([]),
});

export type ProductionConfig = z.infer<typeof ProductionConfig>;
