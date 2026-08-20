import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findSecretsInText, isBinaryPath, isTestFixturePath } from "../check-tracked-secrets.mjs";

// NOTE: tokens below are obviously-fake (all-zero or clearly-labelled) so
// the CLI guard's skip of scripts/__tests__/ is belt-and-suspenders; the
// tokens themselves are not real credentials.

const FAKE_OR_KEY = "sk-or-v1-0000000000000000000000000000000000000000000000000000000000000000";

describe("findSecretsInText", () => {
  // --- MUST FLAG ---

  it("flags a bare OpenRouter key", () => {
    const hits = findSecretsInText(`apiKey = "${FAKE_OR_KEY}"`);
    assert.ok(hits.length > 0);
  });

  it("flags OPENROUTER_API_KEY assignment with a real-looking value", () => {
    const hits = findSecretsInText(`OPENROUTER_API_KEY=${FAKE_OR_KEY}`);
    assert.ok(hits.length > 0);
  });

  it("flags OPENROUTER_API_KEY with quoted real-looking value", () => {
    const hits = findSecretsInText(`OPENROUTER_API_KEY="${FAKE_OR_KEY}"`);
    assert.ok(hits.length > 0);
  });

  it("flags AI_SDR_CONTEXT_SECRET with a 16+ char value", () => {
    const hits = findSecretsInText("AI_SDR_CONTEXT_SECRET=supersecretvalue1234");
    assert.ok(hits.length > 0);
  });

  it("flags CRM_INGEST_SECRET with a 16+ char value", () => {
    const hits = findSecretsInText("CRM_INGEST_SECRET=supersecretvalue1234");
    assert.ok(hits.length > 0);
  });

  it("flags CRM_INGEST_SECRET with a quoted 16+ char value", () => {
    const hits = findSecretsInText('CRM_INGEST_SECRET="supersecretvalue1234"');
    assert.ok(hits.length > 0);
  });

  it("flags AI_SDR_CONTEXT_SECRET with exactly 16 chars", () => {
    const hits = findSecretsInText("AI_SDR_CONTEXT_SECRET=1234567890abcdef");
    assert.ok(hits.length > 0);
  });

  // --- MUST RETURN [] ---

  it("returns [] for empty string", () => {
    assert.deepEqual(findSecretsInText(""), []);
  });

  it("returns [] for ordinary prose", () => {
    assert.deepEqual(findSecretsInText("This is just a normal comment with no secrets here."), []);
  });

  it("returns [] for ordinary code with no secrets", () => {
    assert.deepEqual(
      findSecretsInText(
        'const url = "https://openrouter.ai/api/v1/chat";\nconst model = "openai/gpt-4o";',
      ),
      [],
    );
  });

  it("returns [] for CRM_INGEST_SECRET= with empty value", () => {
    assert.deepEqual(findSecretsInText("CRM_INGEST_SECRET="), []);
  });

  it("returns [] for CRM_INGEST_SECRET=changeme placeholder", () => {
    assert.deepEqual(findSecretsInText("CRM_INGEST_SECRET=changeme"), []);
  });

  it('returns [] for CRM_INGEST_SECRET="<your-secret>" placeholder', () => {
    assert.deepEqual(findSecretsInText('CRM_INGEST_SECRET="<your-secret>"'), []);
  });

  it("returns [] for AI_SDR_CONTEXT_SECRET= with empty value", () => {
    assert.deepEqual(findSecretsInText("AI_SDR_CONTEXT_SECRET="), []);
  });

  it('returns [] for AI_SDR_CONTEXT_SECRET="<your-secret>" placeholder', () => {
    assert.deepEqual(findSecretsInText('AI_SDR_CONTEXT_SECRET="<your-secret>"'), []);
  });

  it("returns [] for OPENROUTER_API_KEY= with empty value", () => {
    assert.deepEqual(findSecretsInText("OPENROUTER_API_KEY="), []);
  });

  it("returns [] for OPENROUTER_API_KEY with placeholder-only value", () => {
    assert.deepEqual(findSecretsInText("OPENROUTER_API_KEY=changeme"), []);
  });

  it("returns [] for value shorter than 16 chars on secret keys", () => {
    assert.deepEqual(findSecretsInText("CRM_INGEST_SECRET=short"), []);
    assert.deepEqual(findSecretsInText("AI_SDR_CONTEXT_SECRET=tooshort"), []);
  });

  // --- Fix 1: OR_KEY_ASSIGNMENT new coverage ---

  it("flags OPENROUTER_API_KEY=sk-or-v1-... via the bare-key rule (not the assignment rule)", () => {
    // sk-or-v1- keys are caught by OR_KEY_BARE; assignment rule must NOT double-flag
    const hits = findSecretsInText(`OPENROUTER_API_KEY=${FAKE_OR_KEY}`);
    assert.equal(hits.length, 1, "exactly one hit from the bare-key rule");
    assert.match(hits[0], /sk-or-v1-/);
  });

  it("flags OPENROUTER_API_KEY assigned a non-openrouter-format high-entropy value (new coverage)", () => {
    // A 20+ char value that does NOT start with sk-or-v1- — this is the gap
    // the assignment rule now covers.
    const hits = findSecretsInText("OPENROUTER_API_KEY=abcdefghijklmnopqrstuvwxyz123456");
    assert.ok(hits.length > 0, "expected a hit");
    assert.match(hits[0], /non-openrouter-format/);
  });

  it("flags OPENROUTER_KEY (alternate var name) with high-entropy non-sk-or-v1- value", () => {
    const hits = findSecretsInText("OPENROUTER_KEY=abcdefghijklmnopqrstuvwxyz123456");
    assert.ok(hits.length > 0, "expected a hit");
    assert.match(hits[0], /non-openrouter-format/);
  });

  it("does NOT flag OPENROUTER_API_KEY=changeme placeholder", () => {
    assert.deepEqual(findSecretsInText("OPENROUTER_API_KEY=changeme"), []);
  });

  it("does NOT flag OPENROUTER_API_KEY=<your-key> placeholder", () => {
    assert.deepEqual(findSecretsInText("OPENROUTER_API_KEY=<your-key>"), []);
  });

  it("does NOT flag OPENROUTER_API_KEY= empty assignment", () => {
    assert.deepEqual(findSecretsInText("OPENROUTER_API_KEY="), []);
  });

  it("does NOT flag OPENROUTER_API_KEY with a value shorter than 20 chars", () => {
    // e.g. "shortval" — 8 chars, not high entropy length-wise
    assert.deepEqual(findSecretsInText("OPENROUTER_API_KEY=shortval"), []);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: CLI predicate unit tests (pure, no git/shell spawning)
// ---------------------------------------------------------------------------

describe("isBinaryPath", () => {
  it("treats .png as binary", () => {
    assert.equal(isBinaryPath("assets/logo.png"), true);
  });

  it("treats .pdf as binary", () => {
    assert.equal(isBinaryPath("docs/spec.pdf"), true);
  });

  it("treats .lock as binary", () => {
    assert.equal(isBinaryPath("pnpm-lock.yaml.lock"), true);
  });

  it("does NOT treat .ts as binary", () => {
    assert.equal(isBinaryPath("src/index.ts"), false);
  });

  it("does NOT treat .mjs as binary", () => {
    assert.equal(isBinaryPath("scripts/check-tracked-secrets.mjs"), false);
  });

  it("does NOT treat .json as binary", () => {
    assert.equal(isBinaryPath("package.json"), false);
  });
});

describe("isTestFixturePath", () => {
  it("skips scripts/__tests__/ paths", () => {
    assert.equal(isTestFixturePath("scripts/__tests__/fixtures/fake-key.env"), true);
    assert.equal(isTestFixturePath("scripts/__tests__/check-tracked-secrets.test.mjs"), true);
  });

  it("does NOT skip normal source paths", () => {
    assert.equal(isTestFixturePath("src/index.ts"), false);
    assert.equal(isTestFixturePath("packages/ai-sdr-contracts/src/index.ts"), false);
    assert.equal(isTestFixturePath("scripts/check-tracked-secrets.mjs"), false);
  });

  it("handles backslash paths by normalizing to forward slashes", () => {
    assert.equal(isTestFixturePath("scripts\\__tests__\\fixture.mjs"), true);
  });
});
