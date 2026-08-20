import { describe, expect, it } from "vitest";
import { assertCanSpamCompliance, buildListUnsubscribeHeaders } from "../canspam.js";

describe("assertCanSpamCompliance", () => {
  it("throws on empty string postalAddress", () => {
    expect(() => assertCanSpamCompliance({ postalAddress: "" })).toThrow(/postal address/i);
  });

  it("throws on whitespace-only postalAddress", () => {
    expect(() => assertCanSpamCompliance({ postalAddress: "   " })).toThrow(/postal address/i);
  });

  it("throws on placeholder with brackets", () => {
    expect(() => assertCanSpamCompliance({ postalAddress: "[set your address here]" })).toThrow(
      /placeholder/i,
    );
  });

  it("throws on placeholder with [set...]", () => {
    expect(() => assertCanSpamCompliance({ postalAddress: "[set postal address]" })).toThrow(
      /placeholder/i,
    );
  });

  it("passes on a real address", () => {
    expect(() =>
      assertCanSpamCompliance({ postalAddress: "123 Main St, San Francisco, CA 94105" }),
    ).not.toThrow();
  });

  it("passes with optional unsubscribeUrl provided", () => {
    expect(() =>
      assertCanSpamCompliance({
        postalAddress: "456 Oak Ave, Austin, TX 78701",
        unsubscribeUrl: "https://example.com/unsubscribe",
      }),
    ).not.toThrow();
  });

  it("passes on minimal single-word address", () => {
    expect(() => assertCanSpamCompliance({ postalAddress: "SomeAddress" })).not.toThrow();
  });

  it('throws on "[Set your postal address]" (bracket placeholder)', () => {
    expect(() => assertCanSpamCompliance({ postalAddress: "[Set your postal address]" })).toThrow(
      /placeholder/i,
    );
  });

  it('throws on "TODO: set address" (todo keyword)', () => {
    expect(() => assertCanSpamCompliance({ postalAddress: "TODO: set address" })).toThrow(
      /placeholder/i,
    );
  });

  it('throws on "Placeholder Address" (placeholder keyword)', () => {
    expect(() => assertCanSpamCompliance({ postalAddress: "Placeholder Address" })).toThrow(
      /placeholder/i,
    );
  });

  it('passes on a valid real address "123 Main St, Springfield, IL 62704"', () => {
    expect(() =>
      assertCanSpamCompliance({ postalAddress: "123 Main St, Springfield, IL 62704" }),
    ).not.toThrow();
  });
});

describe("buildListUnsubscribeHeaders", () => {
  it("returns List-Unsubscribe header with angle brackets", () => {
    const url = "https://app.example.com/unsubscribe?token=abc";
    const headers = buildListUnsubscribeHeaders(url);
    expect(headers["List-Unsubscribe"]).toBe(`<${url}>`);
  });

  it("returns List-Unsubscribe-Post header with one-click value", () => {
    const headers = buildListUnsubscribeHeaders("https://example.com/unsub");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("returns exactly two headers", () => {
    const headers = buildListUnsubscribeHeaders("https://example.com/unsub");
    expect(Object.keys(headers)).toHaveLength(2);
  });
});
