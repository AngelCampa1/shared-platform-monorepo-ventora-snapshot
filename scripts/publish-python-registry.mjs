import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pyDir = path.join(rootDir, "py");
const localEnvPath = path.join(rootDir, ".env.publish.local");
const uvRunner = resolveUvRunner();

function parseArgs(argv) {
  const options = { dryRun: false, packages: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--packages") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--packages requires a comma-separated package list");
      }
      options.packages = new Set(
        value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      );
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.info(`Usage: pnpm publish:python [--dry-run] [--packages ventora-billing,ventora-storage]

Environment:
  VENTORA_PYTHON_REGISTRY_URL    Cloudflare Worker Python index URL (e.g. https://host/)
  VENTORA_PYTHON_REGISTRY_TOKEN  Admin token stored as REGISTRY_ADMIN_TOKEN in the Worker
  VENTORA_PYTHON_REGISTRY_HOST   Expected registry hostname for typo protection
  UV_BIN                         Path to the uv executable (defaults to "uv" on PATH)

Builds each Python workspace package with uv, then uploads the wheel and sdist to the
private Cloudflare Python index. The script loads .env.publish.local from the repo root
when present; shell environment variables take precedence over values in that file.`);
}

async function loadLocalPublishEnv() {
  if (!existsSync(localEnvPath)) {
    return;
  }
  const contents = await readFile(localEnvPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value.replace(/^(['"])(.*)\1$/, "$2");
  }
}

function readToml(contents, key) {
  const match = new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`, "m").exec(contents);
  return match ? match[1] : null;
}

function normalizeName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function canRun(command, args) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveUvRunner() {
  if (process.env.UV_BIN) {
    return { command: process.env.UV_BIN, args: [] };
  }

  const candidates = [
    { command: "uv", args: [] },
    { command: "python", args: ["-m", "uv"] },
    { command: "py", args: ["-m", "uv"] },
  ];
  for (const candidate of candidates) {
    if (canRun(candidate.command, [...candidate.args, "--version"])) {
      return candidate;
    }
  }
  return { command: "uv", args: [] };
}

async function discoverPackages() {
  const rootToml = await readFile(path.join(pyDir, "pyproject.toml"), "utf8");
  const membersBlock = /members\s*=\s*\[([^\]]*)\]/m.exec(rootToml);
  if (!membersBlock) {
    throw new Error("Could not parse [tool.uv.workspace] members in py/pyproject.toml");
  }
  const members = [...membersBlock[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);

  const packages = [];
  for (const member of members) {
    const tomlPath = path.join(pyDir, member, "pyproject.toml");
    if (!existsSync(tomlPath)) {
      throw new Error(`Workspace member ${member} has no pyproject.toml`);
    }
    const toml = await readFile(tomlPath, "utf8");
    const name = readToml(toml, "name");
    const version = readToml(toml, "version");
    const requiresPython = readToml(toml, "requires-python");
    if (!name || !version) {
      throw new Error(`Workspace member ${member} is missing name or version`);
    }
    packages.push({ member, name, version, requiresPython });
  }

  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function registryConfig(options) {
  const registryUrl = process.env.VENTORA_PYTHON_REGISTRY_URL;
  const token = process.env.VENTORA_PYTHON_REGISTRY_TOKEN;
  const expectedHost = process.env.VENTORA_PYTHON_REGISTRY_HOST?.trim().toLowerCase();

  if (options.dryRun) {
    return { registryUrl: "https://dry-run.invalid", token: "dry-run" };
  }
  if (!registryUrl) {
    throw new Error("VENTORA_PYTHON_REGISTRY_URL is required");
  }
  if (!token) {
    throw new Error("VENTORA_PYTHON_REGISTRY_TOKEN is required");
  }

  const parsed = new URL(registryUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("VENTORA_PYTHON_REGISTRY_URL must use https");
  }
  const publicHosts = new Set([
    "pypi.org",
    "upload.pypi.org",
    "files.pythonhosted.org",
    "test.pypi.org",
  ]);
  if (publicHosts.has(parsed.hostname)) {
    throw new Error("Refusing to publish Ventora private packages to a public Python index");
  }
  if (!expectedHost) {
    throw new Error(
      "VENTORA_PYTHON_REGISTRY_HOST is required to pin the private Python registry host",
    );
  }
  if (parsed.hostname !== expectedHost) {
    throw new Error(
      `VENTORA_PYTHON_REGISTRY_URL host ${parsed.hostname} does not match VENTORA_PYTHON_REGISTRY_HOST ${expectedHost}`,
    );
  }

  return { registryUrl: parsed.toString().replace(/\/$/, ""), token };
}

function authHeader(token) {
  return `Basic ${Buffer.from(`__token__:${token}`).toString("base64")}`;
}

function buildPackage(member, outDir) {
  execFileSync(
    uvRunner.command,
    [...uvRunner.args, "build", "--package", member, "--out-dir", outDir],
    {
      cwd: pyDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );
}

async function existingFiles(config, normalizedName) {
  const response = await fetch(`${config.registryUrl}/simple/${normalizedName}/`, {
    headers: {
      Authorization: authHeader(config.token),
      Accept: "application/vnd.pypi.simple.v1+json",
    },
  });
  if (response.status === 404) {
    return new Set();
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to read ${normalizedName} index: ${response.status} ${body}`);
  }
  const index = await response.json();
  const files = Array.isArray(index?.files) ? index.files : [];
  return new Set(files.map((file) => file.filename));
}

async function uploadArtifact(config, pkg, filePath) {
  const filename = path.basename(filePath);
  const bytes = await readFile(filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const isWheel = filename.endsWith(".whl");

  const form = new FormData();
  form.append(":action", "file_upload");
  form.append("protocol_version", "1");
  form.append("metadata_version", "2.1");
  form.append("name", pkg.name);
  form.append("version", pkg.version);
  form.append("filetype", isWheel ? "bdist_wheel" : "sdist");
  form.append("pyversion", isWheel ? "py3" : "source");
  form.append("sha256_digest", sha256);
  if (pkg.requiresPython) {
    form.append("requires_python", pkg.requiresPython);
  }
  form.append("content", new Blob([bytes]), filename);

  const response = await fetch(`${config.registryUrl}/legacy/`, {
    method: "POST",
    headers: { Authorization: authHeader(config.token) },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to upload ${filename}: ${response.status} ${body}`);
  }
}

async function main() {
  await loadLocalPublishEnv();
  const options = parseArgs(process.argv.slice(2));
  const config = registryConfig(options);
  const packages = await discoverPackages();
  const namesByKey = new Map();
  for (const pkg of packages) {
    namesByKey.set(pkg.name, pkg);
    namesByKey.set(pkg.member, pkg);
  }

  let selected = packages;
  if (options.packages) {
    const unknown = [...options.packages].filter((name) => !namesByKey.has(name));
    if (unknown.length > 0) {
      throw new Error(`Unknown package selection: ${unknown.join(", ")}`);
    }
    const wanted = new Set([...options.packages].map((name) => namesByKey.get(name).name));
    selected = packages.filter((pkg) => wanted.has(pkg.name));
  }

  for (const pkg of selected) {
    const normalizedName = normalizeName(pkg.name);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "ventora-pyreg-"));
    try {
      buildPackage(pkg.member, tempDir);
      const artifacts = (await readdir(tempDir)).filter(
        (entry) => entry.endsWith(".whl") || entry.endsWith(".tar.gz"),
      );
      if (artifacts.length === 0) {
        throw new Error(`uv build produced no artifacts for ${pkg.name}`);
      }

      if (options.dryRun) {
        console.info(`Would publish ${pkg.name}@${pkg.version} (${artifacts.sort().join(", ")})`);
        continue;
      }

      const published = await existingFiles(config, normalizedName);
      for (const artifact of artifacts) {
        if (published.has(artifact)) {
          console.info(`Skipping ${artifact}; already published`);
          continue;
        }
        await uploadArtifact(config, pkg, path.join(tempDir, artifact));
        console.info(`Published ${artifact}`);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
