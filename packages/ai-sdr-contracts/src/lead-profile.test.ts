import { describe, expect, test } from "vitest";
import {
  type ContactInfo,
  type LeadDerived,
  type LeadProfile,
  type LeadQualification,
  type LeadStatus,
  isContactInfo,
  isLeadDerived,
  isLeadProfile,
  isLeadQualification,
  isLeadStatus,
} from "./index.js";

describe("isContactInfo", () => {
  test("accepts a fully-populated contact", () => {
    const contact: ContactInfo = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      company: "Analytical Engines",
      role: "Director",
      phone: "+1-555-0100",
    };
    expect(isContactInfo(contact)).toBe(true);
  });

  test("accepts a partially-populated contact and an empty object", () => {
    expect(isContactInfo({ email: "ada@example.com" })).toBe(true);
    expect(isContactInfo({})).toBe(true);
  });

  test("rejects wrong field types", () => {
    expect(isContactInfo({ email: 1 })).toBe(false);
    expect(isContactInfo({ name: 5 })).toBe(false);
    expect(isContactInfo({ company: true })).toBe(false);
    expect(isContactInfo({ role: {} })).toBe(false);
    expect(isContactInfo({ phone: [] })).toBe(false);
  });

  test("rejects non-objects, arrays, and null", () => {
    expect(isContactInfo(null)).toBe(false);
    expect(isContactInfo(undefined)).toBe(false);
    expect(isContactInfo("contact")).toBe(false);
    expect(isContactInfo(42)).toBe(false);
    expect(isContactInfo([])).toBe(false);
  });
});

describe("isLeadStatus", () => {
  test("accepts every valid status", () => {
    const statuses: LeadStatus[] = [
      "new",
      "qualifying",
      "qualified",
      "handoff_requested",
      "accepted",
      "disqualified",
    ];
    for (const status of statuses) {
      expect(isLeadStatus(status)).toBe(true);
    }
  });

  test("rejects unknown values and non-strings", () => {
    expect(isLeadStatus("unknown")).toBe(false);
    expect(isLeadStatus("")).toBe(false);
    expect(isLeadStatus(1)).toBe(false);
    expect(isLeadStatus(null)).toBe(false);
    expect(isLeadStatus(undefined)).toBe(false);
  });
});

describe("isLeadProfile", () => {
  const baseProfile: LeadProfile = {
    contact: { email: "ada@example.com" },
    qualification: { needPain: "manual reporting" },
    derived: { emailDomain: "example.com" },
  };

  test("accepts a fully-populated profile", () => {
    const qualification: LeadQualification = {
      needPain: "manual reporting",
      authority: "decision maker",
      budgetSignal: "has budget",
      timeline: "this quarter",
      useCase: "grant compliance",
      productInterest: "growth plan",
    };
    const derived: LeadDerived = {
      emailDomain: "example.com",
      utm: { source: "google", medium: "cpc" },
      referrer: "https://example.com",
      pageUrl: "https://example.com/pricing",
      locale: "en-US",
    };
    const profile: LeadProfile = {
      contact: { name: "Ada", email: "ada@example.com" },
      qualification,
      derived,
      fitScore: 80,
      intentScore: 60,
      status: "qualified",
    };
    expect(isLeadProfile(profile)).toBe(true);
  });

  test("accepts a minimal profile with empty nested objects", () => {
    expect(isLeadProfile({ contact: {}, qualification: {}, derived: {} })).toBe(true);
    expect(isLeadProfile(baseProfile)).toBe(true);
  });

  test("rejects when nested objects are missing or not objects", () => {
    expect(isLeadProfile({ qualification: {}, derived: {} })).toBe(false);
    expect(isLeadProfile({ contact: {}, derived: {} })).toBe(false);
    expect(isLeadProfile({ contact: {}, qualification: {} })).toBe(false);
    expect(isLeadProfile({ contact: null, qualification: {}, derived: {} })).toBe(false);
    expect(isLeadProfile({ contact: {}, qualification: [], derived: {} })).toBe(false);
    expect(isLeadProfile({ contact: {}, qualification: {}, derived: "x" })).toBe(false);
  });

  test("rejects when nested object fields have wrong types", () => {
    expect(isLeadProfile({ contact: { email: 1 }, qualification: {}, derived: {} })).toBe(false);
    expect(isLeadProfile({ contact: {}, qualification: { needPain: 1 }, derived: {} })).toBe(false);
    expect(isLeadProfile({ contact: {}, qualification: {}, derived: { locale: 1 } })).toBe(false);
    expect(isLeadProfile({ contact: {}, qualification: {}, derived: { utm: { source: 1 } } })).toBe(
      false,
    );
  });

  test("rejects invalid optional scores and status", () => {
    expect(isLeadProfile({ ...baseProfile, fitScore: "high" })).toBe(false);
    expect(isLeadProfile({ ...baseProfile, intentScore: "low" })).toBe(false);
    expect(isLeadProfile({ ...baseProfile, status: "bogus" })).toBe(false);
  });

  test("rejects non-objects, arrays, and null", () => {
    expect(isLeadProfile(null)).toBe(false);
    expect(isLeadProfile(undefined)).toBe(false);
    expect(isLeadProfile([])).toBe(false);
    expect(isLeadProfile("profile")).toBe(false);
  });
});

describe("isLeadQualification", () => {
  test("accepts a fully-populated qualification", () => {
    const qual: LeadQualification = {
      needPain: "manual reporting",
      authority: "decision maker",
      budgetSignal: "has budget",
      timeline: "this quarter",
      useCase: "grant compliance",
      productInterest: "growth plan",
    };
    expect(isLeadQualification(qual)).toBe(true);
  });

  test("accepts an empty object (all fields optional)", () => {
    expect(isLeadQualification({})).toBe(true);
  });

  test("accepts partial population", () => {
    expect(isLeadQualification({ needPain: "manual reporting" })).toBe(true);
    expect(isLeadQualification({ timeline: "Q3", useCase: "compliance" })).toBe(true);
  });

  test("rejects wrong-typed fields", () => {
    expect(isLeadQualification({ needPain: 1 })).toBe(false);
    expect(isLeadQualification({ authority: true })).toBe(false);
    expect(isLeadQualification({ budgetSignal: {} })).toBe(false);
    expect(isLeadQualification({ timeline: [] })).toBe(false);
    expect(isLeadQualification({ useCase: null })).toBe(false);
    expect(isLeadQualification({ productInterest: 42 })).toBe(false);
  });

  test("rejects non-objects, arrays, and null", () => {
    expect(isLeadQualification(null)).toBe(false);
    expect(isLeadQualification(undefined)).toBe(false);
    expect(isLeadQualification([])).toBe(false);
    expect(isLeadQualification("qual")).toBe(false);
    expect(isLeadQualification(42)).toBe(false);
  });
});

describe("isLeadDerived", () => {
  test("accepts a fully-populated derived object", () => {
    const derived: LeadDerived = {
      emailDomain: "example.com",
      utm: { source: "google", medium: "cpc" },
      referrer: "https://example.com",
      pageUrl: "https://example.com/pricing",
      locale: "en-US",
    };
    expect(isLeadDerived(derived)).toBe(true);
  });

  test("accepts an empty object (all fields optional)", () => {
    expect(isLeadDerived({})).toBe(true);
  });

  test("accepts partial population", () => {
    expect(isLeadDerived({ emailDomain: "example.com" })).toBe(true);
    expect(isLeadDerived({ locale: "en-US" })).toBe(true);
  });

  test("rejects wrong-typed fields", () => {
    expect(isLeadDerived({ emailDomain: 1 })).toBe(false);
    expect(isLeadDerived({ referrer: true })).toBe(false);
    expect(isLeadDerived({ pageUrl: {} })).toBe(false);
    expect(isLeadDerived({ locale: [] })).toBe(false);
  });

  test("rejects utm with non-string values", () => {
    expect(isLeadDerived({ utm: { source: 1 } })).toBe(false);
    expect(isLeadDerived({ utm: { source: null } })).toBe(false);
    expect(isLeadDerived({ utm: "google" })).toBe(false);
    expect(isLeadDerived({ utm: [] })).toBe(false);
  });

  test("rejects non-objects, arrays, and null", () => {
    expect(isLeadDerived(null)).toBe(false);
    expect(isLeadDerived(undefined)).toBe(false);
    expect(isLeadDerived([])).toBe(false);
    expect(isLeadDerived("derived")).toBe(false);
    expect(isLeadDerived(42)).toBe(false);
  });
});
