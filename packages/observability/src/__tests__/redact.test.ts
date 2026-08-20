import { describe, expect, it } from "vitest";
import { HIPAA_RULES } from "../redact-hipaa.js";
import { DEFAULT_RULES, redact } from "../redact.js";
import type { RedactionRules } from "../redact.js";

describe("redact — string patterns", () => {
  it("redacts email addresses", () => {
    const result = redact("Contact us at support@example.com for help.");
    expect(result).toBe("Contact us at [email] for help.");
  });

  it("redacts multiple email addresses in one string", () => {
    const result = redact("From alice@foo.com to bob@bar.org");
    expect(result).toBe("From [email] to [email]");
  });

  it("redacts US phone numbers (dashes)", () => {
    const result = redact("Call me at 555-867-5309");
    expect(result).toBe("Call me at [phone]");
  });

  it("redacts US phone numbers (dots)", () => {
    const result = redact("555.867.5309");
    expect(result).toBe("[phone]");
  });

  it("redacts US phone numbers with +1 prefix", () => {
    const result = redact("+1 555 867 5309");
    expect(result).toBe("[phone]");
  });

  it("redacts JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = redact(`jwt: ${jwt}`);
    expect(result).toBe("jwt: [jwt]");
  });

  it("redacts Bearer tokens (case-insensitive)", () => {
    const result = redact("Authorization: Bearer abcXYZtoken");
    expect(result).toBe("Authorization: Bearer [token]");
  });

  it("redacts credit card numbers (Visa)", () => {
    // Use a Visa pattern that does not start with a 3-digit phone prefix
    const result = redact("Card: 4539578763621486");
    expect(result).toBe("Card: [credit-card]");
  });

  it("redacts IPv4 addresses", () => {
    const result = redact("Server IP: 192.168.1.100");
    expect(result).toBe("Server IP: [ip]");
  });

  it("redacts HIPAA identifiers by default", () => {
    const result = redact("MRN: ABCD-1234 NPI: 1234567890");
    expect(result).toBe("[mrn] [npi]");
  });

  it("redacts HIPAA identifiers by default regardless of label case", () => {
    const result = redact(
      "Mrn: abcd-1234 npi: 1234567890 dea: ab1234567 Date of Service: 01/02/2026",
    );
    expect(result).toBe("[mrn] [npi] [dea] [date-of-service]");
  });

  it("returns non-string primitives unchanged", () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBeNull();
  });
});

describe("redact — fieldKey redaction", () => {
  it("redacts exact field key matches (case-sensitive key, case-insensitive check)", () => {
    const obj = { password: "s3cr3t!" };
    expect(redact(obj)).toEqual({ password: "[redacted]" });
  });

  it("redacts token field", () => {
    expect(redact({ token: "abc" })).toEqual({ token: "[redacted]" });
  });

  it("redacts apiKey field", () => {
    expect(redact({ apiKey: "key-123" })).toEqual({ apiKey: "[redacted]" });
  });

  it("redacts ssn field", () => {
    expect(redact({ ssn: "123-45-6789" })).toEqual({ ssn: "[redacted]" });
  });

  it("redacts authorization field", () => {
    expect(redact({ authorization: "Bearer xyz" })).toEqual({
      authorization: "[redacted]",
    });
  });

  it("preserves non-sensitive fields", () => {
    const obj = { username: "angel", email: "angel@example.com" };
    const result = redact(obj) as typeof obj;
    expect(result.username).toBe("angel");
    expect(result.email).toBe("[email]");
  });
});

describe("redact — keyPattern redaction", () => {
  it("redacts keys matching the sensitive_suffix pattern (ending in 'key')", () => {
    const obj = { privateKey: "sk_live_abc123" };
    expect(redact(obj)).toEqual({ privateKey: "[redacted]" });
  });

  it("redacts keys ending in 'secret'", () => {
    const obj = { clientSecret: "verysecret" };
    expect(redact(obj)).toEqual({ clientSecret: "[redacted]" });
  });

  it("redacts keys ending in 'credential'", () => {
    const obj = { dbCredential: "pass123" };
    expect(redact(obj)).toEqual({ dbCredential: "[redacted]" });
  });
});

describe("redact — nested objects", () => {
  it("recursively redacts nested objects", () => {
    const obj = {
      user: {
        name: "Angel",
        email: "angel@example.com",
        credentials: {
          password: "hunter2",
        },
      },
    };
    const result = redact(obj) as typeof obj;
    expect(result.user.name).toBe("Angel");
    expect(result.user.email).toBe("[email]");
    expect(result.user.credentials.password).toBe("[redacted]");
  });

  it("handles deeply nested objects", () => {
    const obj = { a: { b: { c: { token: "secret" } } } };
    const result = redact(obj) as typeof obj;
    expect(result.a.b.c.token).toBe("[redacted]");
  });
});

describe("redact — arrays", () => {
  it("redacts string elements in arrays", () => {
    const arr = ["user@test.com", "hello", "555-123-4567"];
    const result = redact(arr) as string[];
    expect(result[0]).toBe("[email]");
    expect(result[1]).toBe("hello");
    expect(result[2]).toBe("[phone]");
  });

  it("redacts objects inside arrays", () => {
    const arr = [{ password: "abc" }, { name: "visible" }];
    const result = redact(arr) as Array<{ password?: string; name?: string }>;
    expect(result[0]?.password).toBe("[redacted]");
    expect(result[1]?.name).toBe("visible");
  });

  it("handles nested arrays", () => {
    const arr = [["user@test.com", "safe"]];
    const result = redact(arr) as string[][];
    expect(result[0]?.[0]).toBe("[email]");
    expect(result[0]?.[1]).toBe("safe");
  });
});

describe("redact — custom rules", () => {
  it("applies custom pattern rules when rules param is provided", () => {
    const customRules: RedactionRules = {
      fieldKeys: [],
      keyPatterns: [],
      patterns: [{ name: "zip", pattern: "\\d{5}", replacement: "[zip]" }],
    };
    expect(redact("Zip: 90210", customRules)).toBe("Zip: [zip]");
  });

  it("does NOT apply default rules when custom rules are empty", () => {
    const emptyRules: RedactionRules = {
      fieldKeys: [],
      keyPatterns: [],
      patterns: [],
    };
    const result = redact("angel@example.com", emptyRules);
    expect(result).toBe("angel@example.com");
  });

  it("applies custom hipaa18Extensions rules", () => {
    const customRules: RedactionRules = {
      fieldKeys: [],
      keyPatterns: [],
      patterns: [],
      hipaa18Extensions: [{ name: "case", pattern: "\\bCASE-[0-9]+\\b", replacement: "[case]" }],
    };
    expect(redact("CASE-123 is open", customRules)).toBe("[case] is open");
  });
});

describe("DEFAULT_RULES", () => {
  it("has patterns array with at least email pattern", () => {
    const emailPattern = DEFAULT_RULES.patterns.find((p) => p.name === "email");
    expect(emailPattern).toBeDefined();
    expect(emailPattern?.replacement).toBe("[email]");
  });

  it("has fieldKeys array including password", () => {
    expect(DEFAULT_RULES.fieldKeys).toContain("password");
  });

  it("has keyPatterns array", () => {
    expect(Array.isArray(DEFAULT_RULES.keyPatterns)).toBe(true);
    expect(DEFAULT_RULES.keyPatterns.length).toBeGreaterThan(0);
  });

  it("includes HIPAA extension rules from the shared schema", () => {
    expect(DEFAULT_RULES.hipaa18Extensions?.some((rule) => rule.name === "mrn")).toBe(true);
    expect(redact("MRN: ABCD-1234", DEFAULT_RULES)).toBe("[mrn]");
  });
});

describe("HIPAA_RULES", () => {
  it("includes base email pattern", () => {
    const emailPattern = HIPAA_RULES.patterns.find((p) => p.name === "email");
    expect(emailPattern).toBeDefined();
  });

  it("includes HIPAA-18 mrn pattern", () => {
    const mrnPattern = HIPAA_RULES.patterns.find((p) => p.name === "mrn");
    expect(mrnPattern).toBeDefined();
    expect(mrnPattern?.replacement).toBe("[mrn]");
  });

  it("includes HIPAA-18 npi pattern", () => {
    expect(HIPAA_RULES.patterns.find((p) => p.name === "npi")).toBeDefined();
  });

  it("redacts MRN numbers with HIPAA_RULES", () => {
    // The MRN pattern matches from the label word onward: "MRN: MRN-A1234567" → "[mrn]"
    const result = redact("Patient MRN: MRN-A1234567", HIPAA_RULES);
    expect(result).toBe("Patient [mrn]");
  });

  it("redacts NPI numbers with HIPAA_RULES", () => {
    // HIPAA patterns run first in HIPAA_RULES, so NPI:1234567890 is matched before the phone pattern.
    const result = redact("Provider NPI: NPI:1234567890", HIPAA_RULES);
    expect(result).toBe("Provider NPI: [npi]");
  });

  it("still includes base fieldKeys", () => {
    expect(HIPAA_RULES.fieldKeys).toContain("password");
  });
});
