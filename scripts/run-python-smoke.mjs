#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const candidates = [
  { command: "uv", args: [] },
  { command: "python", args: ["-m", "uv"] },
  { command: "py", args: ["-m", "uv"] },
];

function run(command, args, options = {}) {
  return spawnSync(command, args, { stdio: "inherit", shell: true, ...options });
}

const uv = candidates.find((candidate) => {
  const result = spawnSync(candidate.command, [...candidate.args, "--version"], {
    stdio: "ignore",
    shell: true,
  });
  return result.status === 0;
});

if (uv === undefined) {
  console.error("Could not find uv. Install uv or make `python -m uv` available.");
  process.exit(1);
}

const cwd = "test-consumer/py-consumer";
let result = run(uv.command, [...uv.args, "sync", "--no-editable", "--reinstall"], { cwd });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

result = run(uv.command, [...uv.args, "run", "python", "smoke.py"], { cwd });
process.exit(result.status ?? 1);
