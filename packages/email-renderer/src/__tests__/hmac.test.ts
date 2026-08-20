import { describe, expect, it } from "vitest";
import { generateHmac, verifyHmac } from "../hmac.js";

const SECRET = "test-hmac-secret";
const PAYLOAD = '{"template":"welcome","vars":{"firstName":"Alice"}}';

describe("generateHmac", () => {
  it("returns a 64-character hex string", async () => {
    const hmac = await generateHmac(PAYLOAD, SECRET);
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns consistent output for the same input", async () => {
    const hmac1 = await generateHmac(PAYLOAD, SECRET);
    const hmac2 = await generateHmac(PAYLOAD, SECRET);
    expect(hmac1).toBe(hmac2);
  });

  it("returns different output for different payloads", async () => {
    const hmac1 = await generateHmac(PAYLOAD, SECRET);
    const hmac2 = await generateHmac(`${PAYLOAD} `, SECRET);
    expect(hmac1).not.toBe(hmac2);
  });

  it("returns different output for different secrets", async () => {
    const hmac1 = await generateHmac(PAYLOAD, SECRET);
    const hmac2 = await generateHmac(PAYLOAD, "different-secret");
    expect(hmac1).not.toBe(hmac2);
  });
});

describe("verifyHmac", () => {
  it("returns true for a valid HMAC", async () => {
    const hmac = await generateHmac(PAYLOAD, SECRET);
    const result = await verifyHmac(PAYLOAD, hmac, SECRET);
    expect(result).toBe(true);
  });

  it("returns false for tampered payload", async () => {
    const hmac = await generateHmac(PAYLOAD, SECRET);
    const result = await verifyHmac(`${PAYLOAD}tampered`, hmac, SECRET);
    expect(result).toBe(false);
  });

  it("returns false for tampered HMAC", async () => {
    const hmac = await generateHmac(PAYLOAD, SECRET);
    const tampered = `${hmac.slice(0, -2)}00`;
    const result = await verifyHmac(PAYLOAD, tampered, SECRET);
    expect(result).toBe(false);
  });

  it("returns false for wrong secret", async () => {
    const hmac = await generateHmac(PAYLOAD, SECRET);
    const result = await verifyHmac(PAYLOAD, hmac, "wrong-secret");
    expect(result).toBe(false);
  });

  it("returns false for HMAC that is not 32 bytes (wrong hex length)", async () => {
    const result = await verifyHmac(PAYLOAD, "tooshort", SECRET);
    expect(result).toBe(false);
  });

  it("returns false for a 63-character (odd-length) hex string", async () => {
    // 63 hex chars — one nibble short of a valid SHA-256 hex digest
    const oddHex = "a".repeat(63);
    const result = await verifyHmac(PAYLOAD, oddHex, SECRET);
    expect(result).toBe(false);
  });

  it("returns false for a hex string containing non-hex characters", async () => {
    // Replace last two chars with 'zz' to introduce non-hex characters
    const validHmac = await generateHmac(PAYLOAD, SECRET);
    const nonHex = `${validHmac.slice(0, 62)}zz`;
    const result = await verifyHmac(PAYLOAD, nonHex, SECRET);
    expect(result).toBe(false);
  });
});
