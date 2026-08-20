#!/usr/bin/env node
/**
 * Unit tests for mock-openrouter-sdr.mjs.
 *
 * Covers:
 *   - Chat requests (system prompt WITHOUT "qualification data extractor") return prose.
 *   - Extraction requests (system prompt WITH "qualification data extractor") return
 *     JSON parseable as a LeadProfile with a contact.email field.
 *   - Request bookkeeping counters (requests / chatRequests / extractRequests) increment.
 *   - Non-POST requests receive 405.
 *
 * Run standalone:
 *   node --test scripts/e2e/mock-openrouter-sdr.test.mjs
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CHAT_REPLY, startMockSdrOpenRouter } from "./mock-openrouter-sdr.mjs";

describe("mock-openrouter-sdr", () => {
  /** @type {import("./mock-openrouter-sdr.mjs").MockSdrOpenRouterHandle | undefined} */
  let handle;

  before(async () => {
    handle = await startMockSdrOpenRouter({ port: 0 });
  });

  after(async () => {
    await handle?.close();
  });

  test("url includes localhost and a non-zero port", () => {
    assert.ok(handle, "handle not set");
    assert.match(handle.url, /^http:\/\/localhost:\d+\/openrouter$/);
    assert.ok(handle.port > 0, "port should be > 0");
  });

  test("chat request (system prompt without qualification data extractor) returns prose content", async () => {
    assert.ok(handle, "handle not set");

    const body = {
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful sales assistant for GrantPipe." },
        { role: "user", content: "Hi, can you help me understand what GrantPipe does?" },
      ],
    };

    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: JSON.stringify(body),
    });

    assert.equal(res.status, 200);
    const json = /** @type {unknown} */ (await res.json());
    assert.ok(typeof json === "object" && json !== null, "response should be an object");
    const typed = /** @type {Record<string, unknown>} */ (json);
    assert.ok(Array.isArray(typed.choices), "choices should be an array");
    const first = /** @type {Record<string, unknown>} */ (typed.choices[0]);
    const message = /** @type {Record<string, unknown>} */ (first.message);
    assert.equal(
      message.content,
      CHAT_REPLY,
      "chat response should return the canned CHAT_REPLY prose",
    );
  });

  test("extraction request (system prompt with 'qualification data extractor') returns JSON LeadProfile", async () => {
    assert.ok(handle, "handle not set");

    const body = {
      model: "openai/gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a qualification data extractor for an AI sales assistant. Extract structured lead data.",
        },
        {
          role: "user",
          content: "Extract lead profile from: Hi, I'm Dana Rivera, dana@example.org",
        },
      ],
    };

    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      body: JSON.stringify(body),
    });

    assert.equal(res.status, 200);
    const json = /** @type {unknown} */ (await res.json());
    assert.ok(typeof json === "object" && json !== null, "response should be an object");
    const typed = /** @type {Record<string, unknown>} */ (json);
    assert.ok(Array.isArray(typed.choices), "choices should be an array");
    const first = /** @type {Record<string, unknown>} */ (typed.choices[0]);
    const message = /** @type {Record<string, unknown>} */ (first.message);
    assert.ok(typeof message.content === "string", "content should be a string");

    // Must be valid JSON parseable as a LeadProfile.
    /** @type {unknown} */
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(/** @type {string} */ (message.content));
    }, "extraction response content must be valid JSON");

    assert.ok(
      typeof parsed === "object" && parsed !== null,
      "parsed LeadProfile should be an object",
    );
    const profile = /** @type {Record<string, unknown>} */ (parsed);
    assert.ok(
      typeof profile.contact === "object" && profile.contact !== null,
      "LeadProfile must have a contact field",
    );
    const contact = /** @type {Record<string, unknown>} */ (profile.contact);
    assert.ok(
      typeof contact.email === "string" && contact.email.length > 0,
      `contact.email must be a non-empty string, got ${String(contact.email)}`,
    );
  });

  test("request bookkeeping counters increment correctly", async () => {
    assert.ok(handle, "handle not set");

    const initialRequests = handle.requests.length;
    const initialChat = handle.chatRequests.length;
    const initialExtract = handle.extractRequests.length;

    // Send one chat request.
    await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello" },
        ],
      }),
    });

    assert.equal(handle.requests.length, initialRequests + 1, "requests should have grown by 1");
    assert.equal(
      handle.chatRequests.length,
      initialChat + 1,
      "chatRequests should have grown by 1",
    );
    assert.equal(
      handle.extractRequests.length,
      initialExtract,
      "extractRequests should be unchanged",
    );

    // Send one extraction request.
    await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a qualification data extractor for an AI sales assistant.",
          },
          { role: "user", content: "Extract: name=Test, email=test@example.com" },
        ],
      }),
    });

    assert.equal(
      handle.requests.length,
      initialRequests + 2,
      "requests should have grown by 2 total",
    );
    assert.equal(handle.chatRequests.length, initialChat + 1, "chatRequests should still be +1");
    assert.equal(
      handle.extractRequests.length,
      initialExtract + 1,
      "extractRequests should have grown by 1",
    );
  });

  test("non-POST request returns 405", async () => {
    assert.ok(handle, "handle not set");

    const res = await fetch(handle.url, { method: "GET" });
    assert.equal(res.status, 405, "GET should return 405 Method Not Allowed");

    const json = /** @type {unknown} */ (await res.json());
    assert.ok(typeof json === "object" && json !== null, "405 response should be JSON");
    const typed = /** @type {Record<string, unknown>} */ (json);
    assert.ok(typeof typed.error === "string", "405 response should have an error field");
  });
});
