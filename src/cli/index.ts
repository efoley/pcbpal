#!/usr/bin/env bun

import { Command } from "commander";
import { registerBomCommand } from "../commands/bom/cli.js";
import { registerDoctorCommand } from "../commands/doctor/cli.js";
import { registerInitCommand } from "../commands/init/cli.js";
import { registerLibCommand } from "../commands/lib/cli.js";
import { registerSearchCommand } from "../commands/search/cli.js";
import { registerSubCommand } from "../commands/sub/cli.js";

const program = new Command();

program
  .name("pcbpal")
  .description("CLI companion tool for PCB design")
  .version("0.1.0")
  .option("--json", "Output structured JSON instead of human-formatted text")
  .option("--quiet", "Suppress non-essential output");

registerInitCommand(program);
registerSearchCommand(program);
registerBomCommand(program);
registerLibCommand(program);
registerSubCommand(program);
registerDoctorCommand(program);

program.parse();
