#!/usr/bin/env node

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installSkill, skillName } from "../index.js";

const TARGETS = {
  codex: join(homedir(), ".codex", "skills"),
  agents: join(homedir(), ".agents", "skills"),
  claude: join(homedir(), ".claude", "skills"),
};

function printHelp() {
  console.info(`Install ${skillName} into local agent skill roots.

Usage:
  third-grade-copy-skill install [--target codex|agents|claude|all] [--root <skills-dir>] [--dry-run]

Examples:
  third-grade-copy-skill install
  third-grade-copy-skill install --target all
  third-grade-copy-skill install --root C:\\Users\\<you>\\.codex\\skills
`);
}

function parseArgs(args) {
  const options = { command: "install", target: "codex", root: undefined, dryRun: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "install") {
      options.command = "install";
    } else if (arg === "--target") {
      options.target = args[++index];
    } else if (arg === "--root") {
      options.root = args[++index];
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.target) {
    throw new Error("--target requires codex, agents, claude, or all.");
  }

  return options;
}

function getDestinationRoots(options) {
  if (options.root) {
    return [resolve(options.root)];
  }

  if (options.target === "all") {
    return Object.values(TARGETS);
  }

  const root = TARGETS[options.target];
  if (!root) {
    throw new Error(`Unknown target: ${options.target}`);
  }

  return [root];
}

try {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.command !== "install") {
    throw new Error(`Unknown command: ${options.command}`);
  }

  for (const root of getDestinationRoots(options)) {
    const result = installSkill(root, { dryRun: options.dryRun });
    const action = result.installed ? "Installed" : "Would install";
    console.info(`${action} ${skillName} to ${result.destination}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
