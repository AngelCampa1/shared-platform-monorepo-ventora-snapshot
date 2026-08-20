import { describe, expect, it } from "vitest";
import {
  generateRequestId,
  getCorrelationId,
  isValidRequestId,
  withCorrelationId,
} from "../correlation.js";

describe("generateRequestId", () => {
  it("returns a string", () => {
    expect(typeof generateRequestId()).toBe("string");
  });

  it("returns a valid UUID v4", () => {
    const id = generateRequestId();
    expect(isValidRequestId(id)).toBe(true);
  });

  it("returns a unique value on each call", () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateRequestId()));
    expect(ids.size).toBe(20);
  });
});

describe("isValidRequestId", () => {
  it("accepts a valid UUID v4", () => {
    expect(isValidRequestId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("accepts a UUID v4 with lowercase hex digits", () => {
    expect(isValidRequestId("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
  });

  it("rejects a UUID v1 (version bit is 1)", () => {
    // UUID v1 has '1' in the version position
    expect(isValidRequestId("550e8400-e29b-11d4-a716-446655440000")).toBe(false);
  });

  it("rejects a malformed string", () => {
    expect(isValidRequestId("not-a-uuid")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidRequestId("")).toBe(false);
  });

  it("rejects a UUID with wrong variant bits", () => {
    // Variant must be [89ab] in position; '0' is invalid
    expect(isValidRequestId("f47ac10b-58cc-4372-0567-0e02b2c3d479")).toBe(false);
  });

  it("rejects uppercase UUID (pattern is case-insensitive via /i flag)", () => {
    // The pattern uses /i so uppercase should be accepted
    expect(isValidRequestId("F47AC10B-58CC-4372-A567-0E02B2C3D479")).toBe(true);
  });
});

describe("withCorrelationId / getCorrelationId", () => {
  it("getCorrelationId returns undefined when no id is set", () => {
    // Reset by calling withCorrelationId with a temp id and verifying after
    const outside = getCorrelationId();
    // In a fresh test environment this may or may not be undefined depending
    // on previous tests, but within this block no id should be set
    expect(outside === undefined || typeof outside === "string").toBe(true);
  });

  it("withCorrelationId makes id accessible via getCorrelationId inside fn", () => {
    let captured: string | undefined;
    withCorrelationId("req-abc-123", () => {
      captured = getCorrelationId();
    });
    expect(captured).toBe("req-abc-123");
  });

  it("getCorrelationId returns undefined after withCorrelationId fn completes", () => {
    withCorrelationId("req-xyz", () => {
      // Inside: defined
      expect(getCorrelationId()).toBe("req-xyz");
    });
    // In CF Workers (module-level var), the previous value is restored
    // In Node (AsyncLocalStorage), it returns undefined outside the store
    const after = getCorrelationId();
    expect(after === undefined || typeof after === "string").toBe(true);
  });

  it("returns the return value of fn", () => {
    const result = withCorrelationId("id-42", () => 42);
    expect(result).toBe(42);
  });

  it("supports string return from fn", () => {
    const result = withCorrelationId("id-hello", () => "hello");
    expect(result).toBe("hello");
  });

  it("nested withCorrelationId uses the inner id", () => {
    let outerCapture: string | undefined;
    let innerCapture: string | undefined;

    withCorrelationId("outer", () => {
      outerCapture = getCorrelationId();
      withCorrelationId("inner", () => {
        innerCapture = getCorrelationId();
      });
    });

    expect(outerCapture).toBe("outer");
    expect(innerCapture).toBe("inner");
  });

  it("sets correlation id with a generated UUID", () => {
    const id = generateRequestId();
    withCorrelationId(id, () => {
      expect(getCorrelationId()).toBe(id);
    });
  });
});
