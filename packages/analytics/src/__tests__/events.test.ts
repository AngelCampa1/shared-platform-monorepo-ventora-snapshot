import { describe, expect, it } from "vitest";
import { APPROVED_EVENTS } from "../_generated-events.js";
import type { VentoraProduct } from "../_generated-events.js";

describe("APPROVED_EVENTS", () => {
  it("is non-empty", () => {
    expect(Object.keys(APPROVED_EVENTS).length).toBeGreaterThan(0);
  });

  it("all values are strings", () => {
    for (const [key, value] of Object.entries(APPROVED_EVENTS)) {
      expect(typeof value).toBe("string");
      expect(value).toBe(key);
    }
  });

  it("has the documented active event taxonomy size", () => {
    expect(Object.keys(APPROVED_EVENTS)).toHaveLength(46);
  });

  it("contains expected common events", () => {
    expect(APPROVED_EVENTS.user_signed_up).toBe("user_signed_up");
    expect(APPROVED_EVENTS.user_signed_in).toBe("user_signed_in");
    expect(APPROVED_EVENTS.payment_succeeded).toBe("payment_succeeded");
  });
});

describe("VentoraProduct type", () => {
  it("covers expected products via satisfies check", () => {
    // Type-level test: these strings should satisfy VentoraProduct
    const products = [
      "camaudit",
      "camaudit-v2",
      "grantpipe",
      "lextract",
      "floriva",
      "streamvpn",
    ] as const satisfies readonly VentoraProduct[];

    expect(products).toHaveLength(6);
    expect(products).toContain("camaudit");
    expect(products).toContain("lextract");
  });
});
