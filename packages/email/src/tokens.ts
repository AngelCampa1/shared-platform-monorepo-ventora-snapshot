export type UnsubscribeCategory = "marketing" | "transactional";

type TokenPayload = {
  userId: string;
  category: UnsubscribeCategory;
  iat: number;
};

function base64urlEncode(data: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  const bytes = data;
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    result += chars[b0 >> 2];
    result += chars[((b0 & 3) << 4) | (b1 >> 4)];
    result += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    result += i + 2 < bytes.length ? chars[b2 & 63] : "=";
  }
  return result.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function generateUnsubscribeToken(
  userId: string,
  category: UnsubscribeCategory,
  secret: string,
): Promise<string> {
  const payload: TokenPayload = { userId, category, iat: Math.floor(Date.now() / 1000) };
  const payloadJson = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(payloadJson);
  const payloadB64 = base64urlEncode(payloadBytes);

  const key = await importKey(secret);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  const signatureB64 = base64urlEncode(new Uint8Array(signatureBuffer));

  return `${payloadB64}.${signatureB64}`;
}

export async function verifyUnsubscribeToken(
  token: string,
  secret: string,
  maxAgeSeconds: number = 30 * 24 * 3600,
): Promise<{ userId: string; category: UnsubscribeCategory } | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, signatureB64] = parts as [string, string];

  let payloadJson: string;
  let payload: unknown;
  try {
    const payloadBytes = base64urlDecode(payloadB64);
    payloadJson = new TextDecoder().decode(payloadBytes);
    payload = JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }

  const key = await importKey(secret);
  const encoder = new TextEncoder();

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64urlDecode(signatureB64);
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes.buffer as ArrayBuffer,
    encoder.encode(payloadB64),
  );

  if (!valid) return null;

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("userId" in payload) ||
    !("category" in payload) ||
    typeof (payload as Record<string, unknown>).userId !== "string" ||
    ((payload as Record<string, unknown>).category !== "marketing" &&
      (payload as Record<string, unknown>).category !== "transactional")
  ) {
    return null;
  }

  const typed = payload as TokenPayload;
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (
    typeof typed.iat !== "number" ||
    !Number.isFinite(typed.iat) ||
    typed.iat > nowSeconds ||
    nowSeconds - typed.iat > maxAgeSeconds
  ) {
    return null;
  }

  return { userId: typed.userId, category: typed.category };
}
