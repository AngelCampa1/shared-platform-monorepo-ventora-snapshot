import {
  type CrmLeadIngestRequest,
  type CrmLeadIngestResponse,
  type StableJsonValue,
  buildHmacPayload,
  isCrmLeadIngestResponse,
  signHmacPayload,
  stableJson,
} from "@ventora/ai-sdr-contracts";

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Fetcher type matching Cloudflare Workers' global fetch signature.
 * We accept the standard (input: string, init?: RequestInit) form.
 */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Static-category reason literals for retriable failures.
 * These MUST NOT contain PII — they are category strings only.
 */
export type RetriableReason = "timeout" | "network_error" | "http_429" | "http_5xx";

/**
 * Static-category reason literals for non-retriable (client/contract) failures.
 * These MUST NOT contain PII — they are category strings only.
 */
export type NonRetriableReason = "http_4xx" | "invalid_response";

/**
 * PushResult discriminated union — never throws, always resolves.
 * reason strings MUST NOT contain PII (name/email/phone/company/free text).
 * The literal union enforces the static-category privacy contract at the type level.
 */
export type PushResult =
  | { ok: true; response: CrmLeadIngestResponse }
  | { ok: false; retriable: false; reason: "not_configured" }
  | { ok: false; retriable: true; reason: RetriableReason }
  | { ok: false; retriable: false; reason: NonRetriableReason };

interface PushArgs {
  config: {
    endpoint?: string;
    secret?: string;
  };
  request: CrmLeadIngestRequest;
  fetcher: Fetcher;
  nowFactory: () => Date;
  idFactory: () => string;
  timeoutMs?: number;
}

/**
 * Push a qualified lead to the CRM intake endpoint.
 *
 * Signing mirrors `fetchSignedProductContext` in index.ts:
 *   - X-Ventora-Timestamp: ISO-8601 from nowFactory()
 *   - X-Ventora-Nonce:     hex string from idFactory()
 *   - X-Ventora-Signature: bare 64-hex HMAC
 *
 * The signed path is the URL pathname of the request URL (e.g.
 * `/s/ingest/leads/camaudit`), which is what the CRM verifier sees.
 *
 * PRIVACY GUARANTEE: No PII (contact name/email/phone/company, qualification
 * text) is included in any reason string or log output. reason values are
 * static category strings only.
 */
export async function pushLeadToCrm(args: PushArgs): Promise<PushResult> {
  const { config, request, fetcher, nowFactory, idFactory } = args;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Guard: missing config → skip, never throw.
  const endpoint = config.endpoint?.trim();
  const secret = config.secret?.trim();
  if (!endpoint || !secret) {
    return { ok: false, retriable: false, reason: "not_configured" };
  }

  // Build target URL: endpoint is the base (e.g. https://crm.../s/ingest/leads).
  // Append the productKey segment so the CRM route resolves correctly.
  const targetUrl = `${endpoint}/${encodeURIComponent(request.productKey)}`;
  const url = new URL(targetUrl);
  // The signed path is the pathname only — no query string for POST.
  const path = url.pathname;

  // Build signing artefacts (mirror fetchSignedProductContext pattern).
  const timestamp = nowFactory().toISOString();
  const nonce = idFactory();

  // stableJson requires StableJsonValue; CrmLeadIngestRequest is JSON-serialisable.
  const body = request as unknown as StableJsonValue;

  // requestBody is the wire payload. buildHmacPayload hashes stableJson(body)
  // internally, and requestBody is also stableJson(body) of the same frozen
  // object — so the bytes sent over the wire and the bytes covered by the
  // HMAC digest are byte-identical.
  const requestBody = stableJson(body);

  const hmacPayload = buildHmacPayload({
    timestamp,
    nonce,
    method: "POST",
    path,
    body,
  });

  const signature = signHmacPayload(hmacPayload, secret);

  try {
    const response = await fetcher(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ventora-Timestamp": timestamp,
        "X-Ventora-Nonce": nonce,
        "X-Ventora-Signature": signature,
      },
      body: requestBody,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const status = response.status;

    // 429 → retriable rate-limit; 5xx → retriable server error.
    if (status === 429) {
      return { ok: false, retriable: true, reason: "http_429" };
    }
    if (status >= 500) {
      return { ok: false, retriable: true, reason: "http_5xx" };
    }

    // Other 4xx → non-retriable client/contract error.
    if (status >= 400) {
      return { ok: false, retriable: false, reason: "http_4xx" };
    }

    // 2xx — parse and validate body.
    const parsed: unknown = await response.json();
    if (!isCrmLeadIngestResponse(parsed)) {
      return { ok: false, retriable: false, reason: "invalid_response" };
    }

    return { ok: true, response: parsed };
  } catch (err: unknown) {
    // AbortSignal.timeout fires a DOMException with name "TimeoutError".
    // Any other fetch-level error (network failure, DNS, etc.) is also retriable.
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, retriable: true, reason: "timeout" };
    }
    return { ok: false, retriable: true, reason: "network_error" };
  }
}
