import { describe, expect, test } from "vitest";
import {
  type CrmLeadIngestRequest,
  type CrmLeadIngestResponse,
  type LeadActivityInput,
  type LeadProfile,
  isAiSdrSseEvent,
  isCrmLeadIngestRequest,
  isCrmLeadIngestResponse,
  isLeadActivityInput,
  parseSseEventName,
} from "./index.js";

const profile: LeadProfile = {
  contact: { email: "ada@example.com" },
  qualification: { needPain: "manual reporting" },
  derived: { emailDomain: "example.com" },
};

describe("isLeadActivityInput", () => {
  test("accepts every activity type, with and without payload", () => {
    const activities: LeadActivityInput[] = [
      { type: "session_started" },
      { type: "qualification_updated", payload: { field: "needPain" } },
      { type: "message_summary", payload: {} },
      { type: "handoff_requested" },
      { type: "note", payload: { text: "follow up" } },
    ];
    for (const activity of activities) {
      expect(isLeadActivityInput(activity)).toBe(true);
    }
  });

  test("rejects unknown types and bad payloads", () => {
    expect(isLeadActivityInput({ type: "bogus" })).toBe(false);
    expect(isLeadActivityInput({ type: 1 })).toBe(false);
    expect(isLeadActivityInput({})).toBe(false);
    expect(isLeadActivityInput({ type: "note", payload: "x" })).toBe(false);
    expect(isLeadActivityInput({ type: "note", payload: [] })).toBe(false);
    expect(isLeadActivityInput({ type: "note", payload: null })).toBe(false);
  });

  test("rejects non-objects, arrays, and null", () => {
    expect(isLeadActivityInput(null)).toBe(false);
    expect(isLeadActivityInput(undefined)).toBe(false);
    expect(isLeadActivityInput([])).toBe(false);
    expect(isLeadActivityInput("note")).toBe(false);
  });
});

describe("isCrmLeadIngestRequest", () => {
  const base: CrmLeadIngestRequest = {
    productKey: "grantpipe",
    sdrSessionId: "sess_1",
    profile,
    activities: [{ type: "session_started" }],
    occurredAt: "2026-06-20T16:00:00.000Z",
  };

  test("accepts a valid request, including empty activities", () => {
    expect(isCrmLeadIngestRequest(base)).toBe(true);
    expect(isCrmLeadIngestRequest({ ...base, activities: [] })).toBe(true);
  });

  test("rejects missing or wrong-typed scalar fields", () => {
    expect(isCrmLeadIngestRequest({ ...base, productKey: 1 })).toBe(false);
    expect(isCrmLeadIngestRequest({ ...base, sdrSessionId: undefined })).toBe(false);
    expect(isCrmLeadIngestRequest({ ...base, occurredAt: 0 })).toBe(false);
  });

  test("rejects an invalid profile or activities", () => {
    expect(isCrmLeadIngestRequest({ ...base, profile: { contact: {} } })).toBe(false);
    expect(isCrmLeadIngestRequest({ ...base, activities: "nope" })).toBe(false);
    expect(isCrmLeadIngestRequest({ ...base, activities: [{ type: "bogus" }] })).toBe(false);
  });

  test("rejects non-objects, arrays, and null", () => {
    expect(isCrmLeadIngestRequest(null)).toBe(false);
    expect(isCrmLeadIngestRequest([])).toBe(false);
    expect(isCrmLeadIngestRequest("req")).toBe(false);
  });
});

describe("isCrmLeadIngestResponse", () => {
  test("accepts a valid response", () => {
    const response: CrmLeadIngestResponse = {
      customerId: "cust_1",
      leadId: "lead_1",
      status: "new",
    };
    expect(isCrmLeadIngestResponse(response)).toBe(true);
  });

  test("rejects missing or wrong-typed fields", () => {
    expect(isCrmLeadIngestResponse({ customerId: "c", leadId: "l" })).toBe(false);
    expect(isCrmLeadIngestResponse({ customerId: 1, leadId: "l", status: "new" })).toBe(false);
    expect(isCrmLeadIngestResponse({ customerId: "c", leadId: "l", status: "bogus" })).toBe(false);
  });

  test("rejects non-objects, arrays, and null", () => {
    expect(isCrmLeadIngestResponse(null)).toBe(false);
    expect(isCrmLeadIngestResponse([])).toBe(false);
    expect(isCrmLeadIngestResponse("resp")).toBe(false);
  });
});

describe("lead.captured SSE event", () => {
  test("parseSseEventName recognizes lead.captured", () => {
    expect(parseSseEventName("lead.captured")).toBe("lead.captured");
  });

  test("accepts a valid lead.captured event", () => {
    expect(
      isAiSdrSseEvent({ event: "lead.captured", data: { leadId: "lead_1", status: "new" } }),
    ).toBe(true);
  });

  test("rejects malformed lead.captured events", () => {
    expect(isAiSdrSseEvent({ event: "lead.captured", data: { leadId: "lead_1" } })).toBe(false);
    expect(isAiSdrSseEvent({ event: "lead.captured", data: { status: "new" } })).toBe(false);
    expect(isAiSdrSseEvent({ event: "lead.captured", data: { leadId: 1, status: "new" } })).toBe(
      false,
    );
  });
});
