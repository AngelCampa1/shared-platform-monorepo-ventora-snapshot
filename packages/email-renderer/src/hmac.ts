export async function generateHmac(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyHmac(payload: string, hmac: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // SHA-256 hex digest must be exactly 64 lowercase hex characters
  if (hmac.length !== 64) return false;
  if (!/^[0-9a-f]+$/.test(hmac)) return false;
  // Convert hex string back to Uint8Array (length is guaranteed to be 64 by the guard above)
  const hexBytes = hmac.match(/.{1,2}/g) as RegExpMatchArray;
  const signatureBytes = new Uint8Array(hexBytes.map((h) => Number.parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(payload));
}
