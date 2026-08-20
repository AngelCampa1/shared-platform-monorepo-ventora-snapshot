import type { Env } from "./index.js";

/**
 * Client-assertion replay protection.
 *
 * These live in their OWN module — NOT the worker entry (`index.ts`) — because
 * Cloudflare's module-worker runtime scans every named export of the entry for a
 * valid handler/Durable-Object binding. A non-function export there (e.g. the
 * numeric `CLIENT_ASSERTION_REPLAY_WINDOW_MS` or the `consumedClientAssertions`
 * Map) makes workerd refuse to instantiate the worker with
 * "Incorrect type for map entry ... not of type 'function or ExportedHandler'".
 * Keeping them here lets tests import the seams directly while the entry module
 * exports only its `default` handler and Durable Object classes.
 */
export const consumedClientAssertions = new Map<string, number>();
export const CLIENT_ASSERTION_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const CLIENT_ASSERTION_OBJECT_NAME = "__client_assertions__";

export async function consumeClientAssertion(
  env: Env,
  timestamp: string,
  nonce: string,
  _signature: string,
): Promise<boolean> {
  const now = Date.now();
  const key = `${timestamp}:${nonce}`;
  const expiresAt = now + CLIENT_ASSERTION_REPLAY_WINDOW_MS;
  if (env.AI_CS_SESSIONS) {
    const id = env.AI_CS_SESSIONS.idFromName(CLIENT_ASSERTION_OBJECT_NAME);
    const response = await env.AI_CS_SESSIONS.get(id).fetch(
      "https://ai-cs-session/consume-client-assertion",
      {
        method: "POST",
        body: JSON.stringify({ key, expiresAt }),
      },
    );
    return response.ok;
  }

  for (const [key, expiresAt] of consumedClientAssertions) {
    if (expiresAt <= now) {
      consumedClientAssertions.delete(key);
    }
  }
  if (consumedClientAssertions.has(key)) {
    return false;
  }
  consumedClientAssertions.set(key, expiresAt);
  return true;
}
