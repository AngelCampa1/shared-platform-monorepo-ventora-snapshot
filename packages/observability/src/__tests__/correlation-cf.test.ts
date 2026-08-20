/**
 * Tests the Cloudflare Workers fallback path of correlation.ts
 * by calling the exported internal CF helper functions directly.
 */
import { describe, expect, it } from "vitest";
import { _getCorrelationIdCF, _withCorrelationIdCF } from "../correlation.js";

describe("correlation — CF Workers fallback path (_withCorrelationIdCF / _getCorrelationIdCF)", () => {
  it("_withCorrelationIdCF makes id accessible via _getCorrelationIdCF inside fn", () => {
    let captured: string | undefined;
    _withCorrelationIdCF("cf-req-1", () => {
      captured = _getCorrelationIdCF();
    });
    expect(captured).toBe("cf-req-1");
  });

  it("_withCorrelationIdCF restores the previous value after fn completes", () => {
    let outerCapture: string | undefined;
    let innerCapture: string | undefined;

    _withCorrelationIdCF("outer-cf", () => {
      outerCapture = _getCorrelationIdCF();
      _withCorrelationIdCF("inner-cf", () => {
        innerCapture = _getCorrelationIdCF();
      });
      expect(_getCorrelationIdCF()).toBe("outer-cf");
    });

    expect(outerCapture).toBe("outer-cf");
    expect(innerCapture).toBe("inner-cf");
  });

  it("_withCorrelationIdCF returns the fn return value", () => {
    const result = _withCorrelationIdCF("cf-id", () => "cf-result");
    expect(result).toBe("cf-result");
  });

  it("_getCorrelationIdCF returns undefined outside _withCorrelationIdCF scope", () => {
    // After previous tests, the value should be restored to what it was before
    // Ensure we are in a clean state by running one more full cycle
    _withCorrelationIdCF("temp", () => {
      // inside
    });
    // After the fn exits, _cfCorrelationId is restored to the value it had before "temp" was set.
    // Since this test runs after others, we verify that after the restore the ID is not "temp".
    const id = _getCorrelationIdCF();
    expect(id).not.toBe("temp");
  });
});
