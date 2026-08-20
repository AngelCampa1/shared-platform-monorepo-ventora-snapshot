import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const skillName = "third-grade-copy";

const packageRoot = dirname(fileURLToPath(import.meta.url));

export function getPackageRoot() {
  return packageRoot;
}

export function getSkillPath() {
  return join(packageRoot, "skill", skillName);
}

export function installSkill(destinationRoot, options = {}) {
  if (!destinationRoot) {
    throw new Error("installSkill requires a destination skill root.");
  }

  const source = getSkillPath();
  const destination = resolve(destinationRoot, skillName);

  if (!existsSync(source)) {
    throw new Error(`Bundled skill is missing: ${source}`);
  }

  if (options.dryRun) {
    return { source, destination, installed: false };
  }

  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });

  return { source, destination, installed: true };
}
