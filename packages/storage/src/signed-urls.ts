import type { DirectUploadCapability } from "./types.js";

// HMAC-SHA256 signed URL tokens for pre-authorized downloads
// No external dependencies — uses Web Crypto API

export type DownloadUrlPayload = {
  key: string;
  expiresAt: number; // unix timestamp ms
};

function base64urlEncode(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i] as number);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const paddedStr = pad === 0 ? padded : padded + "=".repeat(4 - pad);
  const binary = atob(paddedStr);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  if (secret.trim() === "") {
    throw new Error("Signing secret must not be blank");
  }
  const keyData = new TextEncoder().encode(secret);
  return crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function hmacSign(data: string, secret: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function hmacVerify(data: string, sig: Uint8Array, secret: string): Promise<boolean> {
  const key = await importHmacKey(secret);
  const signature = new Uint8Array(sig.byteLength);
  signature.set(sig);
  return crypto.subtle.verify("HMAC", key, signature.buffer, new TextEncoder().encode(data));
}

// Serialize payload as JSON, HMAC-SHA256 sign with secret
// Return base64url-encoded `${base64url(json)}.${base64url(sig)}`
export async function signDownloadUrl(
  payload: DownloadUrlPayload,
  secret: string,
): Promise<string> {
  const json = JSON.stringify(payload);
  const encodedPayload = base64urlEncode(new TextEncoder().encode(json));
  const sig = await hmacSign(encodedPayload, secret);
  const encodedSig = base64urlEncode(sig);
  return `${encodedPayload}.${encodedSig}`;
}

// Parse token, verify signature, check expiry
// Return null if invalid or expired
export async function verifyDownloadUrl(
  token: string,
  secret: string,
): Promise<DownloadUrlPayload | null> {
  if (secret.trim() === "") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [encodedPayload, encodedSig] = parts as [string, string];

  let sigBytes: Uint8Array;
  let payloadBytes: Uint8Array;
  try {
    sigBytes = base64urlDecode(encodedSig);
    payloadBytes = base64urlDecode(encodedPayload);
  } catch {
    return null;
  }

  const valid = await hmacVerify(encodedPayload, sigBytes, secret);
  if (!valid) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>).key !== "string" ||
    !Number.isSafeInteger((payload as Record<string, unknown>).expiresAt)
  ) {
    return null;
  }

  const typed = payload as DownloadUrlPayload;
  if (Date.now() > typed.expiresAt) return null;

  return typed;
}

export async function generateCapabilityToken(
  capability: DirectUploadCapability,
  secret: string,
): Promise<string> {
  const json = JSON.stringify(capability);
  const encodedPayload = base64urlEncode(new TextEncoder().encode(json));
  const sig = await hmacSign(encodedPayload, secret);
  const encodedSig = base64urlEncode(sig);
  return `${encodedPayload}.${encodedSig}`;
}

export async function verifyCapabilityToken(
  token: string,
  secret: string,
): Promise<DirectUploadCapability | null> {
  if (secret.trim() === "") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [encodedPayload, encodedSig] = parts as [string, string];

  let sigBytes: Uint8Array;
  let payloadBytes: Uint8Array;
  try {
    sigBytes = base64urlDecode(encodedSig);
    payloadBytes = base64urlDecode(encodedPayload);
  } catch {
    return null;
  }

  const valid = await hmacVerify(encodedPayload, sigBytes, secret);
  if (!valid) return null;

  let capability: unknown;
  try {
    capability = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }

  if (
    typeof capability !== "object" ||
    capability === null ||
    typeof (capability as Record<string, unknown>).key !== "string" ||
    typeof (capability as Record<string, unknown>).contentType !== "string" ||
    !Number.isSafeInteger((capability as Record<string, unknown>).expiresAt)
  ) {
    return null;
  }
  const maxSizeBytes = (capability as Record<string, unknown>).maxSizeBytes;
  if (maxSizeBytes !== undefined && !Number.isSafeInteger(maxSizeBytes)) {
    return null;
  }

  const typed = capability as DirectUploadCapability;
  if (Date.now() > typed.expiresAt) return null;

  return typed;
}
