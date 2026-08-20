import { describe, expect, it } from "vitest";
import { generateUnsubscribeToken, verifyUnsubscribeToken } from "../tokens.js";

const SECRET = "test-secret-key-for-hmac";

async function signedToken(payload: Record<string, unknown>, secret = SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const b64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let payloadB64 = "";
  for (let i = 0; i < payloadBytes.length; i += 3) {
    const b0 = payloadBytes[i] ?? 0;
    const b1 = payloadBytes[i + 1] ?? 0;
    const b2 = payloadBytes[i + 2] ?? 0;
    payloadB64 += b64Chars[b0 >> 2];
    payloadB64 += b64Chars[((b0 & 3) << 4) | (b1 >> 4)];
    payloadB64 += i + 1 < payloadBytes.length ? b64Chars[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    payloadB64 += i + 2 < payloadBytes.length ? b64Chars[b2 & 63] : "=";
  }
  payloadB64 = payloadB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  const sigBytes = new Uint8Array(sigBuffer);
  let sigB64 = "";
  for (let i = 0; i < sigBytes.length; i += 3) {
    const b0 = sigBytes[i] ?? 0;
    const b1 = sigBytes[i + 1] ?? 0;
    const b2 = sigBytes[i + 2] ?? 0;
    sigB64 += b64Chars[b0 >> 2];
    sigB64 += b64Chars[((b0 & 3) << 4) | (b1 >> 4)];
    sigB64 += i + 1 < sigBytes.length ? b64Chars[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    sigB64 += i + 2 < sigBytes.length ? b64Chars[b2 & 63] : "=";
  }
  return `${payloadB64}.${sigB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")}`;
}

describe("generateUnsubscribeToken", () => {
  it("produces a two-part dot-separated token", async () => {
    const token = await generateUnsubscribeToken("user-123", "marketing", SECRET);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBeTruthy();
    expect(parts[1]).toBeTruthy();
  });

  it("each part is non-empty base64url-like string", async () => {
    const token = await generateUnsubscribeToken("user-abc", "transactional", SECRET);
    const [payload, sig] = token.split(".");
    // base64url: no +, /, = characters
    expect(payload).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(sig).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("two calls with same inputs produce different tokens (different iat)", async () => {
    const token1 = await generateUnsubscribeToken("user-123", "marketing", SECRET);
    await new Promise((r) => setTimeout(r, 1100));
    const token2 = await generateUnsubscribeToken("user-123", "marketing", SECRET);
    // Payload will differ due to different iat
    expect(token1).not.toBe(token2);
  });

  it("stores iat as epoch seconds for Python compatibility", async () => {
    const token = await generateUnsubscribeToken("user-123", "marketing", SECRET);
    const [payloadPart] = token.split(".");
    const payloadJson = atob((payloadPart ?? "").replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson) as { iat: number };

    expect(payload.iat).toBeLessThan(10_000_000_000);
  });
});

describe("verifyUnsubscribeToken", () => {
  it("round-trips marketing token correctly", async () => {
    const token = await generateUnsubscribeToken("user-123", "marketing", SECRET);
    const result = await verifyUnsubscribeToken(token, SECRET);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.category).toBe("marketing");
  });

  it("round-trips transactional token correctly", async () => {
    const token = await generateUnsubscribeToken("user-456", "transactional", SECRET);
    const result = await verifyUnsubscribeToken(token, SECRET);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-456");
    expect(result?.category).toBe("transactional");
  });

  it("returns null for wrong secret", async () => {
    const token = await generateUnsubscribeToken("user-123", "marketing", SECRET);
    const result = await verifyUnsubscribeToken(token, "wrong-secret");
    expect(result).toBeNull();
  });

  it("returns null for malformed token (no dot)", async () => {
    const result = await verifyUnsubscribeToken("notavalidtoken", SECRET);
    expect(result).toBeNull();
  });

  it("returns null for malformed token (too many parts)", async () => {
    const result = await verifyUnsubscribeToken("a.b.c", SECRET);
    expect(result).toBeNull();
  });

  it("returns null for empty string", async () => {
    const result = await verifyUnsubscribeToken("", SECRET);
    expect(result).toBeNull();
  });

  it("returns null for tampered payload", async () => {
    const token = await generateUnsubscribeToken("user-123", "marketing", SECRET);
    const [, sig] = token.split(".");
    // Encode a different payload and reuse original signature
    const fakePayload = btoa(
      JSON.stringify({
        userId: "hacker",
        category: "marketing",
        iat: Math.floor(Date.now() / 1000),
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    const tampered = `${fakePayload}.${sig ?? ""}`;
    const result = await verifyUnsubscribeToken(tampered, SECRET);
    expect(result).toBeNull();
  });

  it("returns null when payload has invalid base64", async () => {
    const result = await verifyUnsubscribeToken("!!!invalid!!!.validsig", SECRET);
    expect(result).toBeNull();
  });

  it("returns null when signature has invalid base64 chars (valid payload)", async () => {
    // Use a real token to get a valid payload part, then replace signature with invalid base64
    const token = await generateUnsubscribeToken("user-123", "marketing", SECRET);
    const [payloadPart] = token.split(".");
    // Attach signature with chars atob will reject
    const invalidSig = "!!!not-base64!!!";
    const result = await verifyUnsubscribeToken(`${payloadPart ?? ""}.${invalidSig}`, SECRET);
    expect(result).toBeNull();
  });

  it("verifies a token within max age (default 30 days)", async () => {
    const token = await generateUnsubscribeToken("user-123", "marketing", SECRET);
    // Default maxAgeSeconds is 30 days — a freshly generated token must pass
    const result = await verifyUnsubscribeToken(token, SECRET);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("user-123");
    expect(result?.category).toBe("marketing");
  });

  it("returns null for an expired token (maxAgeSeconds=0)", async () => {
    const token = await generateUnsubscribeToken("user-123", "marketing", SECRET);
    await new Promise((r) => setTimeout(r, 1100));
    const result = await verifyUnsubscribeToken(token, SECRET, 0);
    expect(result).toBeNull();
  });

  it("returns null for a token older than custom maxAgeSeconds", async () => {
    // Build a token whose iat is 10 seconds in the past
    const pastIat = Math.floor(Date.now() / 1000) - 10;
    // We can't call generateUnsubscribeToken with a custom iat, so craft one manually
    const payload = JSON.stringify({ userId: "user-old", category: "marketing", iat: pastIat });
    const encoder = new TextEncoder();
    const payloadBytes = encoder.encode(payload);
    const b64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let b64 = "";
    for (let i = 0; i < payloadBytes.length; i += 3) {
      const b0 = payloadBytes[i] ?? 0;
      const b1 = payloadBytes[i + 1] ?? 0;
      const b2 = payloadBytes[i + 2] ?? 0;
      b64 += b64Chars[b0 >> 2];
      b64 += b64Chars[((b0 & 3) << 4) | (b1 >> 4)];
      b64 += i + 1 < payloadBytes.length ? b64Chars[((b1 & 15) << 2) | (b2 >> 6)] : "=";
      b64 += i + 2 < payloadBytes.length ? b64Chars[b2 & 63] : "=";
    }
    const payloadB64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
    const sigBytes = new Uint8Array(sigBuffer);
    let sigB64 = "";
    for (let i = 0; i < sigBytes.length; i += 3) {
      const b0 = sigBytes[i] ?? 0;
      const b1 = sigBytes[i + 1] ?? 0;
      const b2 = sigBytes[i + 2] ?? 0;
      sigB64 += b64Chars[b0 >> 2];
      sigB64 += b64Chars[((b0 & 3) << 4) | (b1 >> 4)];
      sigB64 += i + 1 < sigBytes.length ? b64Chars[((b1 & 15) << 2) | (b2 >> 6)] : "=";
      sigB64 += i + 2 < sigBytes.length ? b64Chars[b2 & 63] : "=";
    }
    const sigB64Url = sigB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const craftedToken = `${payloadB64}.${sigB64Url}`;
    // maxAgeSeconds=5 → token is 10s old → expired
    const result = await verifyUnsubscribeToken(craftedToken, SECRET, 5);
    expect(result).toBeNull();
  });

  it("returns null for a signed token with a legacy millisecond iat", async () => {
    const token = await signedToken({
      userId: "user-legacy",
      category: "marketing",
      iat: Date.now(),
    });

    const result = await verifyUnsubscribeToken(token, SECRET);

    expect(result).toBeNull();
  });

  it("returns null for a signed token with a future iat", async () => {
    const token = await signedToken({
      userId: "user-future",
      category: "marketing",
      iat: Math.floor(Date.now() / 1000) + 60,
    });

    const result = await verifyUnsubscribeToken(token, SECRET);

    expect(result).toBeNull();
  });

  it("returns null when HMAC is valid but payload has wrong structure (missing userId)", async () => {
    // Sign a payload that has valid JSON but missing userId
    const badPayload = JSON.stringify({
      category: "marketing",
      iat: Math.floor(Date.now() / 1000),
    });
    const encoder = new TextEncoder();
    const payloadBytes = encoder.encode(badPayload);
    // base64url encode
    const b64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let b64 = "";
    for (let i = 0; i < payloadBytes.length; i += 3) {
      const b0 = payloadBytes[i] ?? 0;
      const b1 = payloadBytes[i + 1] ?? 0;
      const b2 = payloadBytes[i + 2] ?? 0;
      b64 += b64Chars[b0 >> 2];
      b64 += b64Chars[((b0 & 3) << 4) | (b1 >> 4)];
      b64 += i + 1 < payloadBytes.length ? b64Chars[((b1 & 15) << 2) | (b2 >> 6)] : "=";
      b64 += i + 2 < payloadBytes.length ? b64Chars[b2 & 63] : "=";
    }
    const payloadB64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    // Sign it with the correct secret
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
    const sigBytes = new Uint8Array(sigBuffer);
    let sigB64 = "";
    for (let i = 0; i < sigBytes.length; i += 3) {
      const b0 = sigBytes[i] ?? 0;
      const b1 = sigBytes[i + 1] ?? 0;
      const b2 = sigBytes[i + 2] ?? 0;
      sigB64 += b64Chars[b0 >> 2];
      sigB64 += b64Chars[((b0 & 3) << 4) | (b1 >> 4)];
      sigB64 += i + 1 < sigBytes.length ? b64Chars[((b1 & 15) << 2) | (b2 >> 6)] : "=";
      sigB64 += i + 2 < sigBytes.length ? b64Chars[b2 & 63] : "=";
    }
    const sigB64Url = sigB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    const craftedToken = `${payloadB64}.${sigB64Url}`;
    const result = await verifyUnsubscribeToken(craftedToken, SECRET);
    expect(result).toBeNull();
  });
});
