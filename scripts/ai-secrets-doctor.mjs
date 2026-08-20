#!/usr/bin/env node
/**
 * ai-secrets-doctor — live drift detector for the @ventora AI-SDR / AI-CS
 * shared-secret topology.
 *
 * WHY THIS EXISTS
 * ---------------
 * The AI-SDR and AI-CS Cloudflare Workers talk to each product over two HMAC
 * handshakes (a client-assertion secret and a context secret). Cloudflare
 * secrets are write-only, so when a value silently drifts on one side the only
 * symptom is a 401/502 at runtime. This script signs real probe requests with
 * the CANONICAL values and reports, per surface, whether the live deployment
 * still accepts them — turning silent drift into a red row you can see.
 *
 * WHAT IT CHECKS (and does NOT)
 * -----------------------------
 *  - Worker client-assertion secret: POST a canonically-signed /v1/sessions and
 *    expect 201 (allowed origin) + 403 (disallowed origin). 401 => the worker's
 *    secret drifted from canonical.
 *  - Product context secret: sign a GET to each product's context endpoint as
 *    the worker would and read the verdict. 200 => match. "Invalid signature"
 *    => the product's secret drifted. A downstream authz failure (membership /
 *    unknown user) still proves the SIGNATURE was accepted = secret matches.
 *  - It does NOT exercise the full chat round-trip or the worker's OWN context
 *    secret (write-only, only observable through an authenticated chat). For the
 *    end-to-end "does chat actually answer" proof, run the per-repo authed E2E
 *    (see scripts/ai-secrets-runbook.md). This doctor is the fast, no-creds
 *    secret-drift gate; the E2E is the full-behaviour gate.
 *
 * VALUES
 * ------
 * Canonical secret values are read from (first match wins):
 *   1. process.env (AI_SDR_CLIENT_ASSERTION_SECRET, AI_SDR_CONTEXT_SECRET,
 *      AI_CS_CLIENT_ASSERTION_SECRET, AI_CS_CONTEXT_SECRET)
 *   2. a dotenv-style file: --values <path>, else $AI_SECRETS_FILE, else
 *      ./.ai-secrets.local (gitignored).
 *
 * USAGE
 *   node scripts/ai-secrets-doctor.mjs            # human table, exit 1 on drift
 *   node scripts/ai-secrets-doctor.mjs --json     # machine-readable JSON
 *   node scripts/ai-secrets-doctor.mjs --agent ai-cs   # only one agent
 *
 * Every surface in the manifest is probed; unreachable domains surface as a
 * DARK row (detected from the network failure itself, not a manifest flag).
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

// ---- tiny arg parser ----------------------------------------------------
const argv = process.argv.slice(2);
const flags = {
  json: argv.includes("--json"),
  agent: readOpt("--agent"),
  values: readOpt("--values"),
};
function readOpt(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

// ---- HMAC primitives (byte-identical to the worker + every product) -----
function sortStable(v) {
  if (Array.isArray(v)) return v.map(sortStable);
  if (v && typeof v === "object") {
    return Object.keys(v)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortStable(v[k]);
        return acc;
      }, {});
  }
  return v;
}
const stableJson = (v) => JSON.stringify(sortStable(v));
const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const sign = (payload, secret) =>
  createHmac("sha256", Buffer.from(secret, "utf8")).update(payload, "utf8").digest("hex");
function buildPayload({ timestamp, nonce, method, path, body }) {
  return `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${sha256Hex(stableJson(body))}`;
}

// ---- value loading ------------------------------------------------------
const REQUIRED_KEYS = [
  "AI_SDR_CLIENT_ASSERTION_SECRET",
  "AI_SDR_CONTEXT_SECRET",
  "AI_CS_CLIENT_ASSERTION_SECRET",
  "AI_CS_CONTEXT_SECRET",
];

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadValues() {
  const fileCandidates = [
    flags.values,
    process.env.AI_SECRETS_FILE,
    join(REPO_ROOT, ".ai-secrets.local"),
  ].filter(Boolean);
  let fromFile = {};
  let fileUsed = null;
  for (const candidate of fileCandidates) {
    try {
      fromFile = parseDotenv(readFileSync(candidate, "utf8"));
      fileUsed = candidate;
      break;
    } catch {
      /* try next */
    }
  }
  const values = {};
  for (const key of REQUIRED_KEYS) {
    values[key] = process.env[key] || fromFile[key] || "";
  }
  return { values, fileUsed };
}

// ---- classification -----------------------------------------------------
// Maps a probe HTTP response to one of: GREEN | DRIFT | UNSET | DARK | WARN.
function classifyContext(status, bodyText) {
  const b = (bodyText || "").toLowerCase();
  if (status === 200) return { state: "GREEN", note: "signature accepted, context returned" };
  // Signature-rejection detection must be format-agnostic: products word this
  // differently — "Invalid signature" (camaudit/grantpipe), "INVALID_SIGNATURE"
  // + "Request signature is invalid." (lextract). Match any body that names the
  // signature as invalid so a real context-secret drift is never masked by the
  // lenient downstream-authz branch below.
  if (b.includes("signature") && b.includes("invalid"))
    return { state: "DRIFT", note: "product rejected canonical signature" };
  if (status === 503 || /unavailable|missing_config|app context unavailable/.test(b))
    return { state: "UNSET", note: "context secret unset on product (503)" };
  if (/missing signature/.test(b))
    return { state: "WARN", note: "product saw no signature headers (probe/transport issue)" };
  // Past-signature failures (membership, unknown user, 403/404 authz) prove the
  // HMAC was accepted => the secret matches; only downstream authz blocks us.
  if (status === 403 || status === 404 || status === 401)
    return {
      state: "GREEN",
      note: `signature accepted; downstream authz ${status} (${trim(bodyText)})`,
    };
  return { state: "WARN", note: `unexpected ${status}: ${trim(bodyText)}` };
}
function classifyAssertion(status, bodyText) {
  if (status === 201) return { state: "GREEN", note: "worker accepted canonical client assertion" };
  if (status === 401) return { state: "DRIFT", note: "worker rejected canonical client assertion" };
  if (status === 403)
    return { state: "WARN", note: "origin not allow-listed (check AI_*_ALLOWED_ORIGINS)" };
  return { state: "WARN", note: `unexpected ${status}: ${trim(bodyText)}` };
}
const trim = (s) => (s || "").replace(/\s+/g, " ").slice(0, 80);

// ---- probes -------------------------------------------------------------
async function probeAssertion(worker, secret, origin, idField, idValue) {
  const body =
    idField === "productId"
      ? { productId: idValue }
      : { appId: idValue, userId: "ai-secrets-doctor-probe" };
  const ts = new Date().toISOString();
  const nonce = randomUUID();
  const path = worker.sessionPath;
  const sig = sign(buildPayload({ timestamp: ts, nonce, method: "POST", path, body }), secret);
  try {
    const res = await fetch(`${worker.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Ventora-Timestamp": ts,
        "X-Ventora-Nonce": nonce,
        "X-Ventora-Signature": sig,
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: String(err?.message || err), dark: true };
  }
}

async function probeContext(product, worker, secret) {
  const idField = worker.idField; // productId | appId
  const idValue = product.id;
  let url;
  try {
    url = new URL(product.contextEndpoint);
  } catch {
    return { status: 0, body: "bad endpoint URL", dark: true };
  }
  url.searchParams.set(idField, idValue);
  let body;
  if (idField === "productId") {
    // The ai-sdr worker signs only { productId } and never appends currentPath
    // to the context request (fetchSignedProductContext). Mirror that exactly.
    body = { productId: idValue };
  } else {
    const userId = "ai-secrets-doctor-probe";
    url.searchParams.set("userId", userId);
    body = { appId: idValue, userId };
    // Mirror real ai-cs chat traffic: the worker appends currentPath to the
    // context URL query and signs the full pathname+search, but the signed BODY
    // stays { appId, userId } (currentPath is NOT in the body). A handler that
    // wrongly folds currentPath into the signed body verifies fine WITHOUT this
    // param but 401s every real chat — exactly the camaudit AI-CS bug. Send
    // currentPath so that regression class surfaces as DRIFT here.
    url.searchParams.set("currentPath", "/");
  }
  const path = `${url.pathname}${url.search}`;
  const ts = new Date().toISOString();
  const nonce = randomUUID();
  const sig = sign(buildPayload({ timestamp: ts, nonce, method: "GET", path, body }), secret);
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        "X-Ventora-Timestamp": ts,
        "X-Ventora-Nonce": nonce,
        "X-Ventora-Signature": sig,
      },
    });
    return {
      status: res.status,
      body: await res.text(),
      respSig: res.headers.get("X-Ventora-Signature"),
    };
  } catch (err) {
    return { status: 0, body: String(err?.message || err), dark: true };
  }
}

// ---- main ---------------------------------------------------------------
async function main() {
  const manifest = JSON.parse(readFileSync(join(HERE, "ai-secrets-manifest.json"), "utf8"));
  const { values, fileUsed } = loadValues();

  const missing = REQUIRED_KEYS.filter((k) => !values[k]);
  if (missing.length === REQUIRED_KEYS.length) {
    console.error(
      `\n  ✖ No canonical secret values found.\n    Provide them via env vars or a dotenv file (default ./.ai-secrets.local).\n    Expected keys: ${REQUIRED_KEYS.join(", ")}\n`,
    );
    process.exit(2);
  }

  const results = [];

  // Worker client-assertion probes (one per agent), using a sample product as
  // the allowed-origin case, plus a disallowed-origin control.
  for (const [agentKey, worker] of Object.entries(manifest.workers)) {
    if (flags.agent && flags.agent !== agentKey) continue;
    const caSecret = values[worker.clientAssertionKey];
    const sample = manifest.products.find((p) => p.agent === agentKey);
    if (!sample || !caSecret) continue;
    const allowed = await probeAssertion(
      worker,
      caSecret,
      sample.origin,
      worker.idField,
      sample.id,
    );
    results.push({
      kind: "client-assertion",
      agent: agentKey,
      surface: worker.workerName,
      detail: `allowed origin ${sample.origin}`,
      status: allowed.status,
      ...classifyAssertion(allowed.status, allowed.body),
    });
    const denied = await probeAssertion(
      worker,
      caSecret,
      "https://ai-secrets-doctor.invalid",
      worker.idField,
      sample.id,
    );
    results.push({
      kind: "origin-guard",
      agent: agentKey,
      surface: worker.workerName,
      detail: "disallowed origin → expect 403",
      status: denied.status,
      state: denied.status === 403 ? "GREEN" : "WARN",
      note:
        denied.status === 403
          ? "fail-closed on foreign origin"
          : `expected 403, got ${denied.status}`,
    });
  }

  // Product context probes. Every product is probed; unreachable domains are
  // classified as DARK from the network failure itself (see probeContext).
  for (const product of manifest.products) {
    if (flags.agent && flags.agent !== product.agent) continue;
    const worker = manifest.workers[product.agent];
    const ctxSecret = values[worker.contextKey];
    const probe = await probeContext(product, worker, ctxSecret);
    let verdict;
    if (probe.dark) {
      verdict = { state: "DARK", note: `unreachable: ${trim(probe.body)}` };
    } else {
      verdict = classifyContext(probe.status, probe.body);
    }
    results.push({
      kind: "context",
      agent: product.agent,
      surface: `${product.id} (${product.agent})`,
      detail: product.contextEndpoint,
      status: probe.status,
      ...verdict,
    });
  }

  if (flags.json) {
    console.info(JSON.stringify({ valuesFrom: fileUsed || "env", results }, null, 2));
  } else {
    printTable(results, fileUsed);
  }

  // Exit non-zero if any reachable surface drifted or is unset.
  const bad = results.filter((r) => r.state === "DRIFT" || r.state === "UNSET");
  process.exit(bad.length > 0 ? 1 : 0);
}

function printTable(results, fileUsed) {
  const icon = { GREEN: "✅", DRIFT: "🔴", UNSET: "🟠", WARN: "⚠️ ", DARK: "⚫" };
  console.info(`\n  AI secrets doctor — canonical values from: ${fileUsed || "environment"}\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.info(`  ${pad("STATE", 7)} ${pad("KIND", 17)} ${pad("SURFACE", 26)} NOTE`);
  console.info(`  ${"-".repeat(7)} ${"-".repeat(17)} ${"-".repeat(26)} ${"-".repeat(40)}`);
  for (const r of results) {
    console.info(
      `  ${pad(`${icon[r.state] || ""} ${r.state}`, 7)} ${pad(r.kind, 17)} ${pad(r.surface, 26)} ${r.note}`,
    );
  }
  const drift = results.filter((r) => r.state === "DRIFT");
  const unset = results.filter((r) => r.state === "UNSET");
  const dark = results.filter((r) => r.state === "DARK");
  console.info("");
  if (drift.length === 0 && unset.length === 0) {
    console.info(
      `  ✅ No secret drift on any reachable surface.${dark.length ? `  (${dark.length} surface(s) unreachable.)` : ""}\n`,
    );
  } else {
    console.info(
      `  🔴 ${drift.length} drifted, 🟠 ${unset.length} unset. Re-provision per scripts/ai-secrets-runbook.md.\n`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
