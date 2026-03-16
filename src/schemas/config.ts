import { z } from "zod";

export const ProjectConfig = z.object({
  project: z.object({
    name: z.string(),
    version: z.string().default("0.1.0"),
    description: z.string().optional(),
    kicad_project: z.string().optional(),
  }),
  eda: z
    .object({
      tool: z.enum(["kicad"]).default("kicad"),
      version: z.string().optional(),
      ipc_api: z.boolean().default(false),
    })
    .optional(),
  libraries: z
    .object({
      symbol_lib: z.string().default("pcbpal-symbols.kicad_sym"),
      footprint_lib: z.string().default("pcbpal-footprints.pretty"),
    })
    .optional(),
  llm: z
    .object({
      provider: z.enum(["anthropic", "google", "openai"]).optional(),
      model: z.string().optional(),
      review_on_save: z.boolean().default(false),
    })
    .optional(),
  production: z
    .object({
      default_fab: z.string().default("jlcpcb"),
      default_assembly: z.string().default("jlcpcb"),
    })
    .optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfig>;
