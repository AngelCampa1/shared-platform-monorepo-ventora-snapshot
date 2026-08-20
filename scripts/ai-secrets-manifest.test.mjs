import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(
  readFileSync(new URL("./ai-secrets-manifest.json", import.meta.url), "utf8"),
);

test("manifest holds only names and topology — no repo paths, no live/dark status", () => {
  const allowedKeys = new Set([
    "id",
    "agent",
    "origin",
    "contextEndpoint",
    "productCaVar",
    "productCtxVar",
  ]);
  for (const product of manifest.products) {
    for (const key of Object.keys(product)) {
      assert.ok(
        allowedKeys.has(key),
        `product ${product.id}/${product.agent} has unexpected field "${key}" (only topology names/endpoints belong here — no local paths, no deployment state)`,
      );
    }
  }
});

test("worker base URLs use the placeholder account, not a personal subdomain", () => {
  for (const worker of Object.values(manifest.workers)) {
    assert.match(worker.baseUrl, /\.example-account\.workers\.dev$/);
  }
});

test("product hostnames stay illustrative, never a real deployment", () => {
  for (const product of manifest.products) {
    for (const field of ["origin", "contextEndpoint"]) {
      assert.match(
        new URL(product[field]).hostname,
        /(^|\.)example\.com$/,
        `product ${product.id}/${product.agent} field "${field}" points at a real host`,
      );
    }
  }
});

test("no field in the manifest leaks infrastructure narrative (retirement notes, provider UUIDs)", () => {
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /retired/i);
  assert.doesNotMatch(serialized, /railway/i);
  assert.doesNotMatch(serialized, /angel-campa/i);
  assert.doesNotMatch(serialized, /D:\/code|D:\\code/i);
});

test("GrantPipe AI surfaces are still present in the secret inventory (structural continuity)", () => {
  const grantpipeSurfaces = manifest.products.filter((product) => product.id === "grantpipe");

  assert.equal(grantpipeSurfaces.length, 2);
  assert.deepEqual(grantpipeSurfaces.map((product) => product.agent).sort(), ["ai-cs", "ai-sdr"]);
});

test("every product entry has the required topology fields", () => {
  const requiredKeys = [
    "id",
    "agent",
    "origin",
    "contextEndpoint",
    "productCaVar",
    "productCtxVar",
  ];
  for (const product of manifest.products) {
    for (const key of requiredKeys) {
      assert.ok(
        Object.hasOwn(product, key),
        `product ${product.id}/${product.agent} is missing required field "${key}"`,
      );
    }
  }
});

test("canonicalValueKeys and workers stay the source of truth for secret names", () => {
  assert.deepEqual(Object.keys(manifest.canonicalValueKeys).sort(), [
    "AI_CS_CLIENT_ASSERTION_SECRET",
    "AI_CS_CONTEXT_SECRET",
    "AI_SDR_CLIENT_ASSERTION_SECRET",
    "AI_SDR_CONTEXT_SECRET",
  ]);
  assert.deepEqual(Object.keys(manifest.workers).sort(), ["ai-cs", "ai-sdr"]);
});
