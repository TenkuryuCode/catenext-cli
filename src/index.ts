#!/usr/bin/env node
import { Command } from "commander";
import { registerEpicCommands } from "./commands/epic.js";
import { registerInitCommand } from "./commands/init.js";
import { registerInspectCommands } from "./commands/inspect.js";
import { registerOpsCommands } from "./commands/ops.js";
import { registerPersonaCommands } from "./commands/persona.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerReviewCommands } from "./commands/review.js";
import { registerSkillCommands } from "./commands/skill.js";
import {
  registerHandoffCommands,
  registerNextClaimCommands,
  registerTaskCommands,
} from "./commands/task.js";
import { registerWorktreeCommands } from "./commands/worktree.js";
import { findProjectRoot, readConfig, stateFilePath } from "./config.js";
import { checkpointDatabaseFile } from "./db/open.js";

/** Diisi build.mjs dari package.json; "dev" saat dijalankan lewat tsc/tsx. */
const VERSION = process.env.CATENEXT_BUILD_VERSION || "0.0.0-dev";

const program = new Command();

program
  .name("catenext")
  .description("Estafet tugas & konteks antar-agen AI coding")
  .version(VERSION);

registerInitCommand(program);
registerEpicCommands(program);
registerTaskCommands(program);
registerPersonaCommands(program);
registerInspectCommands(program);
registerProjectCommands(program);
registerNextClaimCommands(program);
registerWorktreeCommands(program);
registerHandoffCommands(program);
registerReviewCommands(program);
registerSkillCommands(program);
registerOpsCommands(program, VERSION);

const READ_ONLY_OR_DAEMON_TOP_COMMANDS = new Set(["doctor", "watch", "mcp", "config", "verify"]);

program.hook("postAction", async (_thisCommand, actionCommand) => {
  if (
    actionCommand.parent === program &&
    READ_ONLY_OR_DAEMON_TOP_COMMANDS.has(actionCommand.name())
  ) {
    return;
  }
  try {
    const root = await findProjectRoot(undefined, { managedWorktree: true });
    if (!root) return;
    const config = await readConfig(root);
    checkpointDatabaseFile(stateFilePath(root, config), { onlyIfSidecarExists: true });
  } catch {
    /* ignore shutdown checkpoint errors; never fail CLI exit */
  }
});

await program.parseAsync();
