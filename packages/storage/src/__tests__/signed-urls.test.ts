import { describe, expect, it } from "vitest";
import {
  type DownloadUrlPayload,
  generateCapabilityToken,
  signDownloadUrl,
  verifyCapabilityToken,
  verifyDownloadUrl,
} from "../signed-urls.js";
import type { DirectUploadCapability } from "../types.js";

const SECRET = "test-secret-key-123";
const ALT_SECRET = "different-secret-key-456";

// Helper: create a properly-signed token with arbitrary raw content
async function makeSignedToken(rawPayload: string, secret: string): Promise<string> {
  function b64urlEncode(data: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i] as number);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const encodedPayload = b64urlEncode(new TextEncoder().encode(rawPayload));
  const keyData = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
  return `${encodedPayload}.${b64urlEncode(new Uint8Array(sig))}`;
}

describe("signDownloadUrl", () => {
  it("produces a token with two dot-separated parts", async () => {
    const payload: DownloadUrlPayload = {
      key: "tenant1/file.txt",
      expiresAt: Date.now() + 60_000,
    };
    const token = await signDownloadUrl(payload, SECRET);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBeTruthy();
    expect(parts[1]).toBeTruthy();
  });

  it("produces different tokens for different secrets", async () => {
    const payload: DownloadUrlPayload = {
      key: "tenant1/file.txt",
      expiresAt: Date.now() + 60_000,
    };
    const token1 = await signDownloadUrl(payload, SECRET);
    const token2 = await signDownloadUrl(payload, ALT_SECRET);
    expect(token1).not.toBe(token2);
  });

  it("produces base64url-safe characters only", async () => {
    const payload: DownloadUrlPayload = {
      key: "tenant1/some/path/file.txt",
      expiresAt: Date.now() + 60_000,
    };
    const token = await signDownloadUrl(payload, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9\-_.]+$/);
  });

  it("rejects blank signing secrets", async () => {
    await expect(
      signDownloadUrl({ key: "tenant1/file.txt", expiresAt: Date.now() + 60_000 }, " "),
    ).rejects.toThrow("Signing secret must not be blank");
  });
});

describe("verifyDownloadUrl", () => {
  it("valid token returns the original payload", async () => {
    const payload: DownloadUrlPayload = {
      key: "tenant1/file.txt",
      expiresAt: Date.now() + 60_000,
    };
    const token = await signDownloadUrl(payload, SECRET);
    const result = await verifyDownloadUrl(token, SECRET);
    expect(result).toEqual(payload);
  });

  it("expired token returns null", async () => {
    const payload: DownloadUrlPayload = {
      key: "tenant1/file.txt",
      expiresAt: Date.now() - 1_000, // already expired
    };
    const token = await signDownloadUrl(payload, SECRET);
    const result = await verifyDownloadUrl(token, SECRET);
    expect(result).toBeNull();
  });

  it("tampered payload returns null", async () => {
    const payload: DownloadUrlPayload = {
      key: "tenant1/file.txt",
      expiresAt: Date.now() + 60_000,
    };
    const token = await signDownloadUrl(payload, SECRET);
    const [, sig] = token.split(".");
    // Encode a different payload
    const fakePayload = btoa(
      JSON.stringify({ key: "tenant2/evil.txt", expiresAt: Date.now() + 60_000 }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const tampered = `${fakePayload}.${sig}`;
    const result = await verifyDownloadUrl(tampered, SECRET);
    expect(result).toBeNull();
  });

  it("wrong secret returns null", async () => {
    const payload: DownloadUrlPayload = {
      key: "tenant1/file.txt",
      expiresAt: Date.now() + 60_000,
    };
    const token = await signDownloadUrl(payload, SECRET);
    const result = await verifyDownloadUrl(token, ALT_SECRET);
    expect(result).toBeNull();
  });

  it("malformed token with no dot returns null", async () => {
    const result = await verifyDownloadUrl("nodotintoken", SECRET);
    expect(result).toBeNull();
  });

  it("malformed token with invalid base64 returns null", async () => {
    const result = await verifyDownloadUrl("!!!.!!!invalid", SECRET);
    expect(result).toBeNull();
  });

  it("token with valid sig but invalid JSON payload returns null", async () => {
    // Encode invalid JSON as payload
    const invalidJson = btoa("{not-valid-json}")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    // We can't produce a valid sig for this without the secret, so it should fail sig check
    const result = await verifyDownloadUrl(`${invalidJson}.fakesig`, SECRET);
    expect(result).toBeNull();
  });

  it("signed token with non-JSON content returns null", async () => {
    const token = await makeSignedToken("not-valid-json!!!", SECRET);
    const result = await verifyDownloadUrl(token, SECRET);
    expect(result).toBeNull();
  });

  it("signed token with wrong-shape JSON returns null", async () => {
    const token = await makeSignedToken(JSON.stringify({ foo: "bar" }), SECRET);
    const result = await verifyDownloadUrl(token, SECRET);
    expect(result).toBeNull();
  });

  it("signed token with null JSON returns null", async () => {
    const token = await makeSignedToken("null", SECRET);
    const result = await verifyDownloadUrl(token, SECRET);
    expect(result).toBeNull();
  });

  it("returns null instead of throwing for blank verification secrets", async () => {
    const payload: DownloadUrlPayload = {
      key: "tenant1/file.txt",
      expiresAt: Date.now() + 60_000,
    };
    const token = await signDownloadUrl(payload, SECRET);

    await expect(verifyDownloadUrl(token, "")).resolves.toBeNull();
    await expect(verifyDownloadUrl(token, " ")).resolves.toBeNull();
  });
});

describe("generateCapabilityToken + verifyCapabilityToken", () => {
  it("round-trips a capability successfully", async () => {
    const capability: DirectUploadCapability = {
      key: "tenant1/uploads/image.png",
      contentType: "image/png",
      maxSizeBytes: 5_000_000,
      expiresAt: Date.now() + 600_000,
    };
    const token = await generateCapabilityToken(capability, SECRET);
    const result = await verifyCapabilityToken(token, SECRET);
    expect(result).toEqual(capability);
  });

  it("round-trips capability without optional fields", async () => {
    const capability: DirectUploadCapability = {
      key: "tenant1/uploads/doc.pdf",
      contentType: "application/pdf",
      expiresAt: Date.now() + 300_000,
    };
    const token = await generateCapabilityToken(capability, SECRET);
    const result = await verifyCapabilityToken(token, SECRET);
    expect(result).toEqual(capability);
  });

  it("expired capability returns null", async () => {
    const capability: DirectUploadCapability = {
      key: "tenant1/uploads/image.png",
      contentType: "image/png",
      expiresAt: Date.now() - 1_000, // expired
    };
    const token = await generateCapabilityToken(capability, SECRET);
    const result = await verifyCapabilityToken(token, SECRET);
    expect(result).toBeNull();
  });

  it("wrong secret returns null", async () => {
    const capability: DirectUploadCapability = {
      key: "tenant1/uploads/image.png",
      contentType: "image/png",
      expiresAt: Date.now() + 600_000,
    };
    const token = await generateCapabilityToken(capability, SECRET);
    const result = await verifyCapabilityToken(token, ALT_SECRET);
    expect(result).toBeNull();
  });

  it("tampered token returns null", async () => {
    const capability: DirectUploadCapability = {
      key: "tenant1/uploads/image.png",
      contentType: "image/png",
      expiresAt: Date.now() + 600_000,
    };
    const token = await generateCapabilityToken(capability, SECRET);
    const [, sig] = token.split(".");
    const fakePayload = btoa(
      JSON.stringify({
        key: "evil/path",
        contentType: "image/png",
        expiresAt: Date.now() + 600_000,
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const result = await verifyCapabilityToken(`${fakePayload}.${sig}`, SECRET);
    expect(result).toBeNull();
  });

  it("malformed token returns null", async () => {
    const result = await verifyCapabilityToken("notavalidtoken", SECRET);
    expect(result).toBeNull();
  });

  it("signed capability token with invalid JSON returns null", async () => {
    const token = await makeSignedToken("not-valid-json!!!", SECRET);
    const result = await verifyCapabilityToken(token, SECRET);
    expect(result).toBeNull();
  });

  it("signed capability token with wrong-shape JSON returns null", async () => {
    const token = await makeSignedToken(JSON.stringify({ foo: "bar" }), SECRET);
    const result = await verifyCapabilityToken(token, SECRET);
    expect(result).toBeNull();
  });

  it("signed capability token with null payload returns null", async () => {
    const token = await makeSignedToken("null", SECRET);
    const result = await verifyCapabilityToken(token, SECRET);
    expect(result).toBeNull();
  });

  it("rejects capability tokens with non-numeric maxSizeBytes", async () => {
    const token = await generateCapabilityToken(
      {
        key: "uploads/a.txt",
        contentType: "text/plain",
        expiresAt: Date.now() + 60_000,
        maxSizeBytes: "large",
      } as never,
      SECRET,
    );
    await expect(verifyCapabilityToken(token, SECRET)).resolves.toBeNull();
  });

  it("rejects tokens with fractional numeric fields", async () => {
    const downloadToken = await signDownloadUrl(
      { key: "tenant1/file.txt", expiresAt: Date.now() + 60_000.5 },
      SECRET,
    );
    await expect(verifyDownloadUrl(downloadToken, SECRET)).resolves.toBeNull();

    const capabilityToken = await generateCapabilityToken(
      {
        key: "uploads/a.txt",
        contentType: "text/plain",
        expiresAt: Date.now() + 60_000.5,
        maxSizeBytes: 1.5,
      },
      SECRET,
    );
    await expect(verifyCapabilityToken(capabilityToken, SECRET)).resolves.toBeNull();
  });

  it("rejects blank capability signing secrets and returns null for blank verify secrets", async () => {
    const capability: DirectUploadCapability = {
      key: "tenant1/uploads/image.png",
      contentType: "image/png",
      expiresAt: Date.now() + 600_000,
    };

    await expect(generateCapabilityToken(capability, " ")).rejects.toThrow(
      "Signing secret must not be blank",
    );
    const token = await generateCapabilityToken(capability, SECRET);
    await expect(verifyCapabilityToken(token, "")).resolves.toBeNull();
    await expect(verifyCapabilityToken(token, " ")).resolves.toBeNull();
  });
});
