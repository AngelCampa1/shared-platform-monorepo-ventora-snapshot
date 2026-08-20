import type { LeadProfile } from "@ventora/ai-sdr-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type LeadModelCaller,
  deriveStatus,
  extractLeadProfile,
  scoreLead,
} from "../lead-profile.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function emptyProfile(): LeadProfile {
  return {
    contact: {},
    qualification: {},
    derived: {},
  };
}

function richProfile(): LeadProfile {
  return {
    contact: {
      name: "Jane Doe",
      email: "jane@acme.com",
      company: "Acme Inc",
      role: "CFO",
      phone: "+1-555-0100",
    },
    qualification: {
      needPain: "Too many manual reconciliations",
      authority: "Yes",
      budgetSignal: "$50k budget approved",
      timeline: "Q3 2026",
      useCase: "CAM audit automation",
      productInterest: "Growth plan",
    },
    derived: {
      emailDomain: "acme.com",
      utm: { utm_source: "google", utm_campaign: "cam-audit" },
      referrer: "https://google.com",
      pageUrl: "https://camaudit.io/pricing",
      locale: "en-US",
    },
    fitScore: 1,
    intentScore: 1,
    status: "qualified",
  };
}

function callerReturning(json: unknown): LeadModelCaller {
  return vi.fn().mockResolvedValue(JSON.stringify(json));
}

function callerReturningRaw(raw: string): LeadModelCaller {
  return vi.fn().mockResolvedValue(raw);
}

// ─── extractLeadProfile ─────────────────────────────────────────────────────

describe("extractLeadProfile", () => {
  it("returns prior fields when model output has absent values", async () => {
    const prior = richProfile();
    // Model returns a profile that only has a new name, everything else absent
    const modelOutput = { contact: { name: "New Name" }, qualification: {}, derived: {} };
    const caller = callerReturning(modelOutput);

    const result = await extractLeadProfile({
      transcript: [{ role: "user", content: "Hi" }],
      prior,
      deriveCtx: {},
      modelCaller: caller,
    });

    // Kept prior email, company, role, phone
    expect(result.contact.email).toBe("jane@acme.com");
    expect(result.contact.company).toBe("Acme Inc");
    expect(result.contact.role).toBe("CFO");
    expect(result.contact.phone).toBe("+1-555-0100");
    // Updated name
    expect(result.contact.name).toBe("New Name");
    // Kept prior qualification
    expect(result.qualification.needPain).toBe("Too many manual reconciliations");
    expect(result.qualification.authority).toBe("Yes");
  });

  it("sends the real transcript content (not a placeholder) to the model", async () => {
    const captured: { system: string; user: string }[] = [];
    const caller: LeadModelCaller = vi.fn(async (prompt) => {
      captured.push(prompt);
      return JSON.stringify({ contact: {}, qualification: {}, derived: {} });
    });

    await extractLeadProfile({
      transcript: [
        { role: "user", content: "My email is riley@tanaka.example and I run a CPA firm" },
        { role: "assistant", content: "Great — how many clients do you serve?" },
      ],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(captured).toHaveLength(1);
    const userPrompt = captured[0]?.user ?? "";
    // The extractor's entire purpose is to read the conversation; the model must
    // receive the actual message text, never a "[message]" placeholder.
    expect(userPrompt).toContain("riley@tanaka.example");
    expect(userPrompt).toContain("I run a CPA firm");
    expect(userPrompt).toContain("how many clients do you serve?");
    expect(userPrompt).not.toContain("[message]");
  });

  it("truncates an overlong transcript message in the model prompt", async () => {
    const captured: { system: string; user: string }[] = [];
    const caller: LeadModelCaller = vi.fn(async (prompt) => {
      captured.push(prompt);
      return JSON.stringify({ contact: {}, qualification: {}, derived: {} });
    });
    const long = "x".repeat(5000);

    await extractLeadProfile({
      transcript: [{ role: "user", content: long }],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(captured).toHaveLength(1);
    const userPrompt = captured[0]?.user ?? "";
    // Bounded per-message so a runaway message cannot inflate the prompt: the
    // cap is 2000 chars, so exactly 2000 survive and the 2001st does not.
    expect(userPrompt).not.toContain(long);
    expect(userPrompt).toContain("x".repeat(2000));
    expect(userPrompt).not.toContain("x".repeat(2001));
  });

  it("overwrites prior fields when model returns non-empty new values", async () => {
    const prior: LeadProfile = {
      contact: { email: "old@corp.com", company: "Old Corp" },
      qualification: { needPain: "Old pain" },
      derived: {},
    };
    const modelOutput = {
      contact: { email: "new@startup.io", company: "New Startup" },
      qualification: { needPain: "New pain point discovered" },
      derived: {},
    };
    const caller = callerReturning(modelOutput);

    const result = await extractLeadProfile({
      transcript: [{ role: "user", content: "We switched companies" }],
      prior,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(result.contact.email).toBe("new@startup.io");
    expect(result.contact.company).toBe("New Startup");
    expect(result.qualification.needPain).toBe("New pain point discovered");
  });

  it("derives emailDomain from contact.email (part after @, lowercased)", async () => {
    const caller = callerReturning({
      contact: { email: "User@EXAMPLE.COM" },
      qualification: {},
      derived: {},
    });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(result.derived.emailDomain).toBe("example.com");
  });

  it("does not set emailDomain when no email is present", async () => {
    const caller = callerReturning({ contact: {}, qualification: {}, derived: {} });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(result.derived.emailDomain).toBeUndefined();
  });

  it("extracts utm_* keys from deriveCtx.metadata into derived.utm", async () => {
    const caller = callerReturning({ contact: {}, qualification: {}, derived: {} });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {
        metadata: {
          utm_source: "twitter",
          utm_medium: "cpc",
          utm_campaign: "launch",
          other_key: "ignored",
        },
      },
      modelCaller: caller,
    });

    expect(result.derived.utm).toEqual({
      utm_source: "twitter",
      utm_medium: "cpc",
      utm_campaign: "launch",
    });
    // Non-utm keys must not appear in utm
    expect(result.derived.utm?.other_key).toBeUndefined();
  });

  it("maps pageUrl, referrer, and locale from deriveCtx into derived", async () => {
    const caller = callerReturning({ contact: {}, qualification: {}, derived: {} });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {
        pageUrl: "https://camaudit.io/pricing",
        referrer: "https://google.com/search",
        locale: "fr-FR",
      },
      modelCaller: caller,
    });

    expect(result.derived.pageUrl).toBe("https://camaudit.io/pricing");
    expect(result.derived.referrer).toBe("https://google.com/search");
    expect(result.derived.locale).toBe("fr-FR");
  });

  it("falls back to prior profile when model returns malformed JSON (no throw)", async () => {
    const prior: LeadProfile = {
      contact: { name: "Safe", email: "safe@prior.com" },
      qualification: { needPain: "Cost overruns" },
      derived: {},
    };
    const caller = callerReturningRaw("NOT VALID JSON }{]");

    // Must not throw
    const result = await extractLeadProfile({
      transcript: [{ role: "user", content: "Something" }],
      prior,
      deriveCtx: {},
      modelCaller: caller,
    });

    // Falls back to prior fields
    expect(result.contact.name).toBe("Safe");
    expect(result.contact.email).toBe("safe@prior.com");
    expect(result.qualification.needPain).toBe("Cost overruns");
  });

  it("falls back to empty profile when model returns malformed JSON and prior is null (no throw)", async () => {
    const caller = callerReturningRaw("{ totally broken !");

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    // Must not throw, returns a valid empty structure
    expect(result.contact).toBeDefined();
    expect(result.qualification).toBeDefined();
    expect(result.derived).toBeDefined();
  });

  it("handles null prior without throwing and merges model output correctly", async () => {
    const caller = callerReturning({
      contact: { name: "Alice", email: "alice@newco.io" },
      qualification: { useCase: "Lease audit SaaS" },
      derived: {},
    });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(result.contact.name).toBe("Alice");
    expect(result.contact.email).toBe("alice@newco.io");
    expect(result.qualification.useCase).toBe("Lease audit SaaS");
  });

  it("populates fitScore and intentScore on the returned profile", async () => {
    const caller = callerReturning({
      contact: { email: "x@corp.com" },
      qualification: { needPain: "Pain", budgetSignal: "$30k" },
      derived: {},
    });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(typeof result.fitScore).toBe("number");
    expect(typeof result.intentScore).toBe("number");
    expect(result.fitScore).toBeGreaterThanOrEqual(0);
    expect(result.fitScore).toBeLessThanOrEqual(1);
    expect(result.intentScore).toBeGreaterThanOrEqual(0);
    expect(result.intentScore).toBeLessThanOrEqual(1);
  });

  it("populates status 'new' for all-empty model output and null prior", async () => {
    // M5: assert concrete value, not just defined
    const caller = callerReturning({ contact: {}, qualification: {}, derived: {} });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(result.status).toBe("new");
  });

  it("extracts phone, authority, timeline, and productInterest when model returns non-null values", async () => {
    // Branch coverage: exercises the true-branch of the if-guards in
    // extractContactFields (phone) and extractQualificationFields
    // (authority, timeline, productInterest).
    const caller = callerReturning({
      contact: { phone: "+1-800-555-0199" },
      qualification: {
        authority: "Yes, decision maker",
        timeline: "Q2 2027",
        productInterest: "Scale plan",
      },
      derived: {},
    });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(result.contact.phone).toBe("+1-800-555-0199");
    expect(result.qualification.authority).toBe("Yes, decision maker");
    expect(result.qualification.timeline).toBe("Q2 2027");
    expect(result.qualification.productInterest).toBe("Scale plan");
  });

  it("does not copy null qualification fields from model output (authority, timeline, productInterest, phone)", async () => {
    // When model explicitly returns null for these fields they should remain undefined
    const caller = callerReturning({
      contact: { name: "Bob", email: "bob@org.com", company: "Org", role: "CEO", phone: null },
      qualification: {
        needPain: "Pain",
        authority: null,
        budgetSignal: "Yes",
        timeline: null,
        useCase: "Audit",
        productInterest: null,
      },
      derived: {},
    });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    // Null fields must be absent (not set to undefined explicitly under exactOptionalPropertyTypes)
    expect(result.contact.phone).toBeUndefined();
    expect(result.qualification.authority).toBeUndefined();
    expect(result.qualification.timeline).toBeUndefined();
    expect(result.qualification.productInterest).toBeUndefined();
    // Non-null fields must still be present
    expect(result.contact.name).toBe("Bob");
    expect(result.qualification.needPain).toBe("Pain");
  });

  it("does not set emailDomain when email has no @ character", async () => {
    const caller = callerReturning({
      contact: { email: "not-an-email" },
      qualification: {},
      derived: {},
    });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(result.derived.emailDomain).toBeUndefined();
  });

  it("does not set emailDomain when email ends with @ (empty domain)", async () => {
    const caller = callerReturning({
      contact: { email: "user@" },
      qualification: {},
      derived: {},
    });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(result.derived.emailDomain).toBeUndefined();
  });

  it("does not set utm when metadata has no utm_ keys", async () => {
    const caller = callerReturning({ contact: {}, qualification: {}, derived: {} });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {
        metadata: { other_key: "value", another: "123" },
      },
      modelCaller: caller,
    });

    expect(result.derived.utm).toBeUndefined();
  });

  it("M6: deriveCtx with no metadata key → derived.utm is undefined and no error thrown", async () => {
    // deriveCtx has no metadata property at all
    const caller = callerReturning({ contact: {}, qualification: {}, derived: {} });

    let result: Awaited<ReturnType<typeof extractLeadProfile>> | undefined;
    await expect(async () => {
      result = await extractLeadProfile({
        transcript: [],
        prior: null,
        deriveCtx: {},
        modelCaller: caller,
      });
    }).not.toThrow();

    expect(result?.derived.utm).toBeUndefined();
  });

  it("M1: model returns utm:{} (empty) → a real prior utm is preserved, not wiped", async () => {
    // Model output contains an empty utm object; extractDerivedFields ignores utm
    // from model output, but even if it didn't, an empty utm must not wipe prior.
    const prior: LeadProfile = {
      contact: {},
      qualification: {},
      derived: {
        utm: { utm_source: "google", utm_campaign: "spring" },
      },
    };
    const caller = callerReturning({
      contact: {},
      qualification: {},
      derived: { utm: {} },
    });

    const result = await extractLeadProfile({
      transcript: [],
      prior,
      deriveCtx: {},
      modelCaller: caller,
    });

    // Prior utm must survive — empty model utm must not wipe it
    expect(result.derived.utm).toEqual({ utm_source: "google", utm_campaign: "spring" });
  });

  it("propagates safe derived fields from model output (locale, referrer, pageUrl) but ignores emailDomain", async () => {
    // M7: emailDomain is derived locally from contact.email only.
    // The model must NOT be able to inject an arbitrary emailDomain.
    const caller = callerReturning({
      contact: {},
      qualification: {},
      derived: {
        locale: "de-DE",
        referrer: "https://bing.com",
        pageUrl: "https://camaudit.io",
        // Model emits an emailDomain — this must be ignored when no email is captured.
        emailDomain: "example.com",
      },
    });

    const result = await extractLeadProfile({
      transcript: [],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    // Safe derived fields from model are still merged
    expect(result.derived.locale).toBe("de-DE");
    expect(result.derived.referrer).toBe("https://bing.com");
    expect(result.derived.pageUrl).toBe("https://camaudit.io");
    // emailDomain must be undefined because no email was captured (M7)
    expect(result.derived.emailDomain).toBeUndefined();
  });

  it("modelCaller is invoked with system and user prompts", async () => {
    const caller = callerReturning({ contact: {}, qualification: {}, derived: {} });

    await extractLeadProfile({
      transcript: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
      prior: null,
      deriveCtx: {},
      modelCaller: caller,
    });

    expect(caller).toHaveBeenCalledTimes(1);
    // Optional chaining keeps this safe; the toHaveBeenCalledTimes(1) assertion
    // above already guarantees calls[0] exists.
    const callArg = (caller as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      system: string;
      user: string;
    };
    expect(typeof callArg.system).toBe("string");
    expect(typeof callArg.user).toBe("string");
    expect(callArg.system.length).toBeGreaterThan(0);
  });

  it("does not add retired GrantPipe extraction guidance", async () => {
    const caller = callerReturning({ contact: {}, qualification: {}, derived: {} });

    await extractLeadProfile({
      transcript: [
        {
          role: "user",
          content: "We use spreadsheets for restricted funds and lose audit proof before reports.",
        },
      ],
      prior: null,
      deriveCtx: {},
      productId: "grantpipe",
      modelCaller: caller,
    });

    const callArg = (caller as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      system: string;
      user: string;
    };

    expect(callArg.system).not.toContain("For GrantPipe");
    expect(callArg.system).not.toContain("restricted-fund tracking pain");
    expect(callArg.system).not.toContain("active grants count or range");
    expect(callArg.system).not.toContain("Map GrantPipe answers into the existing fields");
    expect(callArg.system).toContain("qualification data extractor");
    expect(callArg.system).toContain("needPain");
    expect(callArg.system).toContain("useCase");
    expect(callArg.system).toContain("budgetSignal");
    expect(callArg.system).toContain("timeline");
    expect(callArg.system).toContain("authority");
    expect(callArg.system).toContain("productInterest");
  });
});

// ─── scoreLead ──────────────────────────────────────────────────────────────

describe("scoreLead", () => {
  it("returns 0,0 for an empty profile", () => {
    const { fitScore, intentScore } = scoreLead(emptyProfile());
    expect(fitScore).toBe(0);
    expect(intentScore).toBe(0);
  });

  it("clamps scores to [0,1]", () => {
    // richProfile has all fields filled — should clamp at 1
    const { fitScore, intentScore } = scoreLead(richProfile());
    expect(fitScore).toBeGreaterThanOrEqual(0);
    expect(fitScore).toBeLessThanOrEqual(1);
    expect(intentScore).toBeGreaterThanOrEqual(0);
    expect(intentScore).toBeLessThanOrEqual(1);
  });

  it("fitScore increases monotonically as more qualification fields are filled", () => {
    const p0 = emptyProfile();
    const p1: LeadProfile = { ...p0, qualification: { needPain: "Pain" } };
    const p2: LeadProfile = { ...p1, qualification: { needPain: "Pain", useCase: "Use case" } };
    const p3: LeadProfile = {
      ...p2,
      qualification: {
        needPain: "Pain",
        useCase: "Use case",
        budgetSignal: "$20k",
      },
    };

    const s0 = scoreLead(p0).fitScore;
    const s1 = scoreLead(p1).fitScore;
    const s2 = scoreLead(p2).fitScore;
    const s3 = scoreLead(p3).fitScore;

    expect(s1).toBeGreaterThan(s0);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
  });

  it("intentScore increases monotonically as more contact/buying-signal fields are filled", () => {
    const p0 = emptyProfile();
    const p1: LeadProfile = { ...p0, contact: { email: "a@b.com" } };
    const p2: LeadProfile = { ...p1, contact: { email: "a@b.com", phone: "+1555" } };
    const p3: LeadProfile = {
      ...p2,
      qualification: { timeline: "Q4 2026", budgetSignal: "$10k" },
      contact: { email: "a@b.com", phone: "+1555" },
    };

    const s0 = scoreLead(p0).intentScore;
    const s1 = scoreLead(p1).intentScore;
    const s2 = scoreLead(p2).intentScore;
    const s3 = scoreLead(p3).intentScore;

    expect(s1).toBeGreaterThan(s0);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
  });

  it("rewards company field in fitScore", () => {
    const without = emptyProfile();
    const with_: LeadProfile = { ...without, contact: { company: "Acme" } };
    expect(scoreLead(with_).fitScore).toBeGreaterThan(scoreLead(without).fitScore);
  });

  it("rewards role field in fitScore", () => {
    const without = emptyProfile();
    const with_: LeadProfile = { ...without, contact: { role: "CFO" } };
    expect(scoreLead(with_).fitScore).toBeGreaterThan(scoreLead(without).fitScore);
  });

  it("rewards productInterest in fitScore", () => {
    const without = emptyProfile();
    const with_: LeadProfile = {
      ...without,
      qualification: { productInterest: "Growth plan" },
    };
    expect(scoreLead(with_).fitScore).toBeGreaterThan(scoreLead(without).fitScore);
  });

  it("rich profile produces fitScore of 1 (fully rewarded)", () => {
    expect(scoreLead(richProfile()).fitScore).toBe(1);
  });

  it("rich profile produces intentScore of 1 (fully rewarded)", () => {
    expect(scoreLead(richProfile()).intentScore).toBe(1);
  });
});

// ─── deriveStatus ───────────────────────────────────────────────────────────

describe("deriveStatus", () => {
  it("returns 'new' when contact and qualification are empty", () => {
    expect(deriveStatus(emptyProfile())).toBe("new");
  });

  it("returns 'qualifying' when only some qualification fields are filled", () => {
    const p: LeadProfile = {
      ...emptyProfile(),
      qualification: { needPain: "Some pain" },
    };
    expect(deriveStatus(p)).toBe("qualifying");
  });

  it("returns 'qualifying' when only contact info (no qualification) is present", () => {
    const p: LeadProfile = {
      ...emptyProfile(),
      contact: { email: "x@corp.com" },
    };
    expect(deriveStatus(p)).toBe("qualifying");
  });

  it("returns 'qualified' when fitScore >= 0.5 and intentScore >= 0.4", () => {
    // Use a rich profile whose scoreLead produces high scores
    const p = richProfile();
    const { fitScore, intentScore } = scoreLead(p);
    expect(fitScore).toBeGreaterThanOrEqual(0.5);
    expect(intentScore).toBeGreaterThanOrEqual(0.4);
    expect(deriveStatus(p)).toBe("qualified");
  });

  it("returns 'qualifying' when fitScore is below threshold even with high intent", () => {
    // M4: deterministic fixture — only intent signals (email + phone + timeline),
    // no fit signals (no company, role, needPain, useCase, productInterest,
    // budgetSignal, authority). fitScore will be 0 (below 0.5 threshold).
    const p: LeadProfile = {
      contact: { email: "x@corp.com", phone: "+1555" },
      qualification: { timeline: "Q4" },
      derived: {},
    };
    const { fitScore, intentScore } = scoreLead(p);
    // fitScore = 0 (no fit signals); intentScore = email(0.25)+phone(0.15)+timeline(0.25)+bonus(0.10) = 0.75
    expect(fitScore).toBe(0);
    expect(intentScore).toBeGreaterThan(0);
    expect(deriveStatus(p)).toBe("qualifying");
  });

  it("does not return handoff_requested, accepted, or disqualified (set by caller)", () => {
    const validDerivedStatuses = ["new", "qualifying", "qualified"];
    expect(validDerivedStatuses).toContain(deriveStatus(emptyProfile()));
    expect(validDerivedStatuses).toContain(deriveStatus(richProfile()));
  });
});
