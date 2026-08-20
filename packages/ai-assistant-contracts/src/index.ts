export type StableJsonValue =
  | string
  | number
  | boolean
  | null
  | StableJsonValue[]
  | { [key: string]: StableJsonValue };

export interface AiAssistantContextSource {
  id: string;
  title: string;
  url: string;
  excerpt?: string;
}

export interface AiAssistantContext {
  assistantId: string;
  appId: string;
  appName: string;
  description?: string;
  authenticatedOnly?: boolean;
  sources?: AiAssistantContextSource[];
}

export interface AiAssistantMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AiAssistantSessionRequest {
  appId: string;
  userId?: string;
  metadata?: Record<string, string>;
}

export interface AiAssistantSessionResponse {
  sessionId: string;
}

export interface AiAssistantChatRequest {
  sessionId: string;
  message: string;
  history?: AiAssistantMessage[];
}

export interface AiAssistantEscalationRequest {
  sessionId: string;
  reason?: string;
  message?: string;
  contact?: Record<string, string>;
}

export interface AiAssistantEscalationReceipt {
  escalationId: string;
  status: string;
}

export interface AiAssistantRouteReceipt {
  routeId: string;
  destination: string;
}

export interface AiAssistantCta {
  label: string;
  url: string;
}

export interface HmacHeaders {
  timestamp: string;
  nonce: string;
  signature: string;
}

export type HmacVerificationResult =
  | { ok: true }
  | { ok: false; reason: "malformed_signature" | "invalid_signature" | "timestamp_skew" };

export type AiAssistantSseEvent =
  | { event: "session.created"; data: { sessionId: string } }
  | { event: "message.delta"; data: { messageId: string; delta: string } }
  | { event: "source"; data: { source: AiAssistantContextSource } }
  | { event: "cta"; data: { cta: AiAssistantCta } }
  | { event: "escalation.requested"; data: { escalationId: string; reason?: string } }
  | { event: "message.done"; data: { messageId: string } }
  | { event: "error"; data: { code: string; message: string } }
  | { event: "heartbeat"; data: { timestamp: string } };

export type AiAssistantSseEventName = AiAssistantSseEvent["event"];

export type AssistantEventValidator<TEvent extends { event: string; data: unknown }> = (
  value: unknown,
) => value is TEvent;

export type AssistantExtraEventValidators<TEvent extends { event: string; data: unknown }> =
  Partial<
    Record<
      Exclude<TEvent["event"], AiAssistantSseEventName>,
      (data: Record<string, unknown>) => boolean
    >
  >;

export interface AssistantSseEventValidatorOptions {
  sharedEventNames?: readonly AiAssistantSseEventName[];
}

const assistantSseEventNames = new Set<AiAssistantSseEventName>([
  "session.created",
  "message.delta",
  "source",
  "cta",
  "escalation.requested",
  "message.done",
  "error",
  "heartbeat",
]);

export function stableJson(value: StableJsonValue): string {
  return JSON.stringify(sortStable(value));
}

export function sha256Hex(value: string): string {
  return bytesToHex(sha256Bytes(utf8Bytes(value)));
}

export function buildHmacPayload(input: {
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  body: StableJsonValue;
}): string {
  return `${input.timestamp}.${input.nonce}.${input.method.toUpperCase()}.${input.path}.${sha256Hex(stableJson(input.body))}`;
}

export function signHmacPayload(payload: string, secret: string): string {
  return bytesToHex(hmacSha256Bytes(utf8Bytes(secret), utf8Bytes(payload)));
}

export function verifyHmacSignature(input: {
  payload: string;
  signature: string;
  secret: string;
  nowMs?: number;
  timestamp?: number | string;
  maxSkewMs?: number;
}): HmacVerificationResult {
  if (!/^[a-f0-9]{64}$/.test(input.signature)) {
    return { ok: false, reason: "malformed_signature" };
  }

  if (input.timestamp !== undefined) {
    const timestampMs =
      typeof input.timestamp === "string" ? Date.parse(input.timestamp) : input.timestamp;
    const nowMs = input.nowMs ?? Date.now();
    const maxSkewMs = input.maxSkewMs ?? 300_000;

    if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > maxSkewMs) {
      return { ok: false, reason: "timestamp_skew" };
    }
  }

  if (!constantTimeEqualHex(signHmacPayload(input.payload, input.secret), input.signature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true };
}

export function parseAiAssistantSseEventName(value: unknown): AiAssistantSseEventName | null {
  return typeof value === "string" && assistantSseEventNames.has(value as AiAssistantSseEventName)
    ? (value as AiAssistantSseEventName)
    : null;
}

export function isAiAssistantSseEvent(value: unknown): value is AiAssistantSseEvent {
  if (!isRecord(value)) {
    return false;
  }

  switch (value.event) {
    case "session.created":
      return hasRecordData(value, (data) => isString(data.sessionId));
    case "message.delta":
      return hasRecordData(value, (data) => isString(data.messageId) && isString(data.delta));
    case "source":
      return hasRecordData(value, (data) => isAiAssistantContextSource(data.source));
    case "cta":
      return hasRecordData(value, (data) => isAiAssistantCta(data.cta));
    case "escalation.requested":
      return hasRecordData(
        value,
        (data) => isString(data.escalationId) && isOptionalString(data.reason),
      );
    case "message.done":
      return hasRecordData(value, (data) => isString(data.messageId));
    case "error":
      return hasRecordData(value, (data) => isString(data.code) && isString(data.message));
    case "heartbeat":
      return hasRecordData(value, (data) => isString(data.timestamp));
    default:
      return false;
  }
}

export function createAssistantSseEventValidator<TEvent extends { event: string; data: unknown }>(
  extraValidators: AssistantExtraEventValidators<TEvent> = {},
  options: AssistantSseEventValidatorOptions = {},
): AssistantEventValidator<TEvent> {
  const allowedSharedEventNames = new Set(options.sharedEventNames ?? assistantSseEventNames);
  return (value: unknown): value is TEvent => {
    if (
      isRecord(value) &&
      typeof value.event === "string" &&
      allowedSharedEventNames.has(value.event as AiAssistantSseEventName) &&
      isAiAssistantSseEvent(value)
    ) {
      return true;
    }
    if (!isRecord(value) || typeof value.event !== "string" || !isRecord(value.data)) {
      return false;
    }
    const validator = extraValidators[value.event as keyof typeof extraValidators];
    return validator?.(value.data) === true;
  };
}

function sortStable(value: StableJsonValue): StableJsonValue {
  if (Array.isArray(value)) {
    return value.map(sortStable);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const sorted: { [key: string]: StableJsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) {
      sorted[key] = sortStable(child);
    }
  }
  return sorted;
}

function hasRecordData(
  value: Record<string, unknown>,
  predicate: (data: Record<string, unknown>) => boolean,
): boolean {
  return isRecord(value.data) && predicate(value.data);
}

function isAiAssistantContextSource(value: unknown): value is AiAssistantContextSource {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isString(value.url) &&
    isOptionalString(value.excerpt)
  );
}

function isAiAssistantCta(value: unknown): value is AiAssistantCta {
  return isRecord(value) && isString(value.label) && isString(value.url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/* v8 ignore start */
const sha256InitialHash = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const sha256RoundConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function hmacSha256Bytes(key: Uint8Array, message: Uint8Array): Uint8Array {
  const normalizedKey = key.length > 64 ? sha256Bytes(key) : key;
  const innerPad = new Uint8Array(64);
  const outerPad = new Uint8Array(64);

  for (let index = 0; index < 64; index += 1) {
    const keyByte = normalizedKey[index] ?? 0;
    innerPad[index] = keyByte ^ 0x36;
    outerPad[index] = keyByte ^ 0x5c;
  }

  return sha256Bytes(concatBytes(outerPad, sha256Bytes(concatBytes(innerPad, message))));
}

function sha256Bytes(message: Uint8Array): Uint8Array {
  const padded = padSha256Message(message);
  const hash = new Uint32Array(sha256InitialHash);
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      schedule[index] =
        ((padded[position] ?? 0) << 24) |
        ((padded[position + 1] ?? 0) << 16) |
        ((padded[position + 2] ?? 0) << 8) |
        (padded[position + 3] ?? 0);
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotateRight(schedule[index - 15] ?? 0, 7) ^
        rotateRight(schedule[index - 15] ?? 0, 18) ^
        ((schedule[index - 15] ?? 0) >>> 3);
      const s1 =
        rotateRight(schedule[index - 2] ?? 0, 17) ^
        rotateRight(schedule[index - 2] ?? 0, 19) ^
        ((schedule[index - 2] ?? 0) >>> 10);
      schedule[index] = ((schedule[index - 16] ?? 0) + s0 + (schedule[index - 7] ?? 0) + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e ?? 0, 6) ^ rotateRight(e ?? 0, 11) ^ rotateRight(e ?? 0, 25);
      const choose = ((e ?? 0) & (f ?? 0)) ^ (~(e ?? 0) & (g ?? 0));
      const temp1 =
        ((h ?? 0) + sum1 + choose + (sha256RoundConstants[index] ?? 0) + (schedule[index] ?? 0)) >>>
        0;
      const sum0 = rotateRight(a ?? 0, 2) ^ rotateRight(a ?? 0, 13) ^ rotateRight(a ?? 0, 22);
      const majority = ((a ?? 0) & (b ?? 0)) ^ ((a ?? 0) & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temp2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = ((d ?? 0) + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = ((hash[0] ?? 0) + (a ?? 0)) >>> 0;
    hash[1] = ((hash[1] ?? 0) + (b ?? 0)) >>> 0;
    hash[2] = ((hash[2] ?? 0) + (c ?? 0)) >>> 0;
    hash[3] = ((hash[3] ?? 0) + (d ?? 0)) >>> 0;
    hash[4] = ((hash[4] ?? 0) + (e ?? 0)) >>> 0;
    hash[5] = ((hash[5] ?? 0) + (f ?? 0)) >>> 0;
    hash[6] = ((hash[6] ?? 0) + (g ?? 0)) >>> 0;
    hash[7] = ((hash[7] ?? 0) + (h ?? 0)) >>> 0;
  }

  const digest = new Uint8Array(32);
  for (let index = 0; index < hash.length; index += 1) {
    const word = hash[index] ?? 0;
    digest[index * 4] = word >>> 24;
    digest[index * 4 + 1] = word >>> 16;
    digest[index * 4 + 2] = word >>> 8;
    digest[index * 4 + 3] = word;
  }
  return digest;
}

function padSha256Message(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  return padded;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.length + second.length);
  result.set(first);
  result.set(second, first.length);
  return result;
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqualHex(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
/* v8 ignore stop */
