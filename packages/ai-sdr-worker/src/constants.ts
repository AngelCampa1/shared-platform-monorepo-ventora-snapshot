/**
 * Exported constants for the AI-SDR worker.
 *
 * These live in a dedicated module so they can be imported by tests and
 * sibling modules without being exposed as top-level named exports from the
 * worker entry point (index.ts). Wrangler's module-worker runtime rejects
 * non-handler named exports from the entry module.
 */

/** Backoff schedule keyed by attempt count (ms). Index = attempts already made. */
export const PUSH_BACKOFF_MS = [0, 30_000, 120_000, 600_000, 3_600_000] as const;

/**
 * Maximum character length for any model-derived free-text string field sent in
 * a CRM push body. Prevents a runaway model response from inflating the signed
 * POST body and the persisted outbox payload_json.
 *
 * 2 000 chars is generous for a real qualification answer and matches the cap
 * used for product-context source excerpts in minimizeProductContext.
 */
export const MAX_CRM_FIELD_CHARS = 2_000;
