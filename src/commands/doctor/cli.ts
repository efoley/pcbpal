import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { isInteractive } from "../../cli/context.js";
import { fatal, output } from "../../cli/output.js";
import { type DoctorResult, runDoctor } from "./core.js";

function renderDoctorResult(result: DoctorResult): void {
  if (isInteractive()) {
    clack.intro(pc.bold("pcbpal doctor"));
  }

  for (const check of result.checks) {
    const icon = check.ok ? pc.green("✓") : pc.red("✗");
    const msg = `${icon} ${pc.bold(check.name)}: ${check.message}`;
    if (isInteractive()) {
      if (check.ok) {
        clack.log.success(msg);
      } else {
        clack.log.error(msg);
      }
    } else {
      console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.message}`);
    }
  }

  if (isInteractive()) {
    if (result.ok) {
      clack.outro(pc.green("All checks passed"));
    } else {
      clack.outro(pc.red("Some checks failed"));
    }
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check project health and dependencies")
    .action(async () => {
      try {
        const result = await runDoctor();
        output(result, renderDoctorResult);
        if (!result.ok) {
          process.exit(1);
        }
      } catch (e) {
        fatal((e as Error).message);
      }
    });
}
