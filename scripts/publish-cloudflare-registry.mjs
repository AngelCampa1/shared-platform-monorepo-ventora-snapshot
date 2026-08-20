import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(rootDir, "packages");
const localEnvPath = path.join(rootDir, ".env.publish.local");
const npmCli = path.join(
  path.dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);

function parseArgs(argv) {
  const options = {
    dryRun: false,
    tag: "latest",
    packages: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--tag") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--tag requires a value");
      }
      options.tag = value;
      index += 1;
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
  console.info(`Usage: pnpm publish:cloudflare [--dry-run] [--tag latest] [--packages @ventora/foo,@ventora/bar]

Environment:
  VENTORA_REGISTRY_URL    Cloudflare Worker registry URL
  VENTORA_REGISTRY_TOKEN  Admin token stored as REGISTRY_ADMIN_TOKEN in Worker secrets
  VENTORA_REGISTRY_HOST   Expected registry hostname for typo protection

The script also loads .env.publish.local from the repository root when present.
Shell environment variables take precedence over values in that file.`);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
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

async function discoverPackages() {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = path.join(packagesDir, entry.name);
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = await readJson(packageJsonPath);
    if (packageJson.private === true || typeof packageJson.name !== "string") {
      continue;
    }
    packages.push({ dir: packageDir, packageJson });
  }

  return packages.sort((left, right) =>
    left.packageJson.name.localeCompare(right.packageJson.name),
  );
}

function rewriteWorkspaceDependencies(packageJson, versionsByName) {
  const rewritten = structuredClone(packageJson);
  const dependencyFields = [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
    "devDependencies",
  ];

  for (const field of dependencyFields) {
    const dependencies = rewritten[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range !== "string" || !range.startsWith("workspace:")) {
        continue;
      }
      const version = versionsByName.get(name);
      if (!version) {
        throw new Error(`${rewritten.name} depends on ${name}, but ${name} was not discovered`);
      }
      dependencies[name] = version;
    }
  }

  return rewritten;
}

async function copyPackageFiles(sourceDir, stagingDir, packageJson) {
  const files = Array.isArray(packageJson.files) ? packageJson.files : ["dist"];
  for (const file of files) {
    if (typeof file !== "string" || file.startsWith("!")) {
      continue;
    }
    const source = path.join(sourceDir, file);
    if (!existsSync(source)) {
      throw new Error(`${packageJson.name} is missing ${file}; run pnpm build first`);
    }
    await cp(source, path.join(stagingDir, file), { recursive: true });
  }

  for (const optionalFile of ["README.md", "LICENSE", "LICENSE.md"]) {
    const source = path.join(sourceDir, optionalFile);
    if (existsSync(source)) {
      await cp(source, path.join(stagingDir, optionalFile), { recursive: true });
    }
  }
}

async function packPackage(packageInfo, versionsByName) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ventora-registry-"));
  const stagingDir = path.join(tempDir, "package");
  await cp(packageInfo.dir, stagingDir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(packageInfo.dir, source);
      return relative === "" || relative === "package.json";
    },
  });

  try {
    const packageJson = rewriteWorkspaceDependencies(packageInfo.packageJson, versionsByName);
    await writeFile(
      path.join(stagingDir, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    await copyPackageFiles(packageInfo.dir, stagingDir, packageJson);

    const command = existsSync(npmCli) ? process.execPath : "npm";
    const args = existsSync(npmCli)
      ? [npmCli, "pack", "--json", "--pack-destination", tempDir]
      : ["pack", "--json", "--pack-destination", tempDir];
    const output = execFileSync(command, args, {
      cwd: stagingDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const packResult = JSON.parse(output);
    const tarballName = packResult[0]?.filename;
    if (typeof tarballName !== "string") {
      throw new Error(`npm pack did not report a tarball for ${packageJson.name}`);
    }

    const tarballPath = path.join(tempDir, tarballName);
    const tarball = await readFile(tarballPath);

    return {
      cleanup: () => rm(tempDir, { recursive: true, force: true }),
      name: packageJson.name,
      version: packageJson.version,
      packageJson,
      tarballName,
      tarballBase64: tarball.toString("base64"),
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      shasum: createHash("sha1").update(tarball).digest("hex"),
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function registryConfig(options) {
  const registryUrl = process.env.VENTORA_REGISTRY_URL;
  const token = process.env.VENTORA_REGISTRY_TOKEN;
  const expectedHost = process.env.VENTORA_REGISTRY_HOST?.trim().toLowerCase();

  if (options.dryRun) {
    return { registryUrl: "https://dry-run.invalid", token: "dry-run" };
  }
  if (!registryUrl) {
    throw new Error("VENTORA_REGISTRY_URL is required");
  }
  if (!token) {
    throw new Error("VENTORA_REGISTRY_TOKEN is required");
  }

  const parsed = new URL(registryUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("VENTORA_REGISTRY_URL must use https");
  }
  if (parsed.hostname === "registry.npmjs.org" || parsed.hostname === "npm.pkg.github.com") {
    throw new Error("Refusing to publish Ventora private packages to a public or GitHub registry");
  }
  if (!expectedHost) {
    throw new Error("VENTORA_REGISTRY_HOST is required to pin the private registry host");
  }
  if (parsed.hostname !== expectedHost) {
    throw new Error(
      `VENTORA_REGISTRY_URL host ${parsed.hostname} does not match VENTORA_REGISTRY_HOST ${expectedHost}`,
    );
  }

  return { registryUrl: parsed.toString().replace(/\/$/, ""), token };
}

async function versionAlreadyPublished(config, packageJson) {
  const packagePath = encodeURIComponent(packageJson.name);
  const response = await fetch(`${config.registryUrl}/${packagePath}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });

  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to read ${packageJson.name} metadata before publishing: ${response.status} ${body}`,
    );
  }

  const packument = await response.json();
  return Boolean(packument?.versions?.[packageJson.version]);
}

async function publishPackage(config, packedPackage, tag) {
  const response = await fetch(`${config.registryUrl}/-/ventora/packages`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...packedPackage, tag }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to publish ${packedPackage.name}@${packedPackage.version}: ${response.status} ${body}`,
    );
  }
}

async function main() {
  await loadLocalPublishEnv();
  const options = parseArgs(process.argv.slice(2));
  const config = registryConfig(options);
  const packages = await discoverPackages();
  const versionsByName = new Map(
    packages.map((packageInfo) => [packageInfo.packageJson.name, packageInfo.packageJson.version]),
  );
  if (options.packages) {
    const unknownPackages = [...options.packages].filter((name) => !versionsByName.has(name));
    if (unknownPackages.length > 0) {
      throw new Error(`Unknown package selection: ${unknownPackages.join(", ")}`);
    }
  }
  const selected = options.packages
    ? packages.filter((packageInfo) => options.packages.has(packageInfo.packageJson.name))
    : packages;

  if (selected.length === 0) {
    throw new Error("No publishable packages matched the selection");
  }

  for (const packageInfo of selected) {
    if (!options.dryRun && (await versionAlreadyPublished(config, packageInfo.packageJson))) {
      console.info(
        `Skipping ${packageInfo.packageJson.name}@${packageInfo.packageJson.version}; version already exists`,
      );
      continue;
    }

    const packedPackage = await packPackage(packageInfo, versionsByName);
    try {
      if (options.dryRun) {
        console.info(
          `Would publish ${packedPackage.name}@${packedPackage.version} (${packedPackage.tarballName})`,
        );
      } else {
        await publishPackage(config, packedPackage, options.tag);
        console.info(`Published ${packedPackage.name}@${packedPackage.version} as ${options.tag}`);
      }
    } finally {
      await packedPackage.cleanup();
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
