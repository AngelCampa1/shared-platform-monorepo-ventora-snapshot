import { type MockInstance, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmailClient } from "../client.js";

// Mock the resend module
vi.mock("resend", () => {
  const mockSend = vi.fn();
  return {
    Resend: vi.fn().mockImplementation(() => ({
      emails: {
        send: mockSend,
      },
    })),
    __mockSend: mockSend,
  };
});

async function getResendMocks() {
  const resendModule = await import("resend");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = resendModule as unknown as { __mockSend: MockInstance; Resend: MockInstance };
  return { mockSend: mod.__mockSend, MockResend: mod.Resend };
}

const BASE_CONFIG = {
  resendApiKey: "re_test_key",
  defaultFrom: "angel.campa@example.com",
  postalAddress: "123 Main St, San Francisco, CA 94105",
};

describe("createEmailClient", () => {
  it("throws at creation when postalAddress is empty", () => {
    expect(() => createEmailClient({ ...BASE_CONFIG, postalAddress: "" })).toThrow(
      /postal address/i,
    );
  });

  it("throws at creation when postalAddress is a placeholder", () => {
    expect(() => createEmailClient({ ...BASE_CONFIG, postalAddress: "[set address]" })).toThrow(
      /placeholder/i,
    );
  });

  it("creates client successfully with valid config", () => {
    const client = createEmailClient(BASE_CONFIG);
    expect(client).toHaveProperty("send");
    expect(client).toHaveProperty("sendIdempotent");
  });
});

describe("EmailClient.send", () => {
  beforeEach(async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockReset();
  });

  it("calls Resend and returns id on success", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({ data: { id: "email-id-001" }, error: null });

    const client = createEmailClient(BASE_CONFIG);
    const result = await client.send({
      to: "user@example.com",
      subject: "Hello",
      html: "<p>Hi</p>",
    });

    expect(result.id).toBe("email-id-001");
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("adds List-Unsubscribe headers when unsubscribeUrl is provided", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({ data: { id: "email-id-002" }, error: null });

    const client = createEmailClient(BASE_CONFIG);
    await client.send({
      to: "user@example.com",
      subject: "Newsletter",
      html: "<p>Content</p>",
      unsubscribeUrl: "https://app.example.com/unsubscribe?token=xyz",
    });

    const callArgs = mockSend.mock.calls[0] as unknown[];
    const sendParams = callArgs[0] as Record<string, unknown>;
    const headers = sendParams.headers as Record<string, string>;

    expect(headers["List-Unsubscribe"]).toBe("<https://app.example.com/unsubscribe?token=xyz>");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("does NOT add List-Unsubscribe headers when unsubscribeUrl is absent", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({ data: { id: "email-id-003" }, error: null });

    const client = createEmailClient(BASE_CONFIG);
    await client.send({
      to: "user@example.com",
      subject: "Transactional",
      html: "<p>Receipt</p>",
    });

    const callArgs = mockSend.mock.calls[0] as unknown[];
    const sendParams = callArgs[0] as Record<string, unknown>;
    // No headers key, or headers doesn't have List-Unsubscribe
    if (sendParams.headers) {
      const headers = sendParams.headers as Record<string, string>;
      expect(headers["List-Unsubscribe"]).toBeUndefined();
    } else {
      expect(sendParams.headers).toBeUndefined();
    }
  });

  it("uses defaultFrom when from is not specified", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({ data: { id: "email-id-004" }, error: null });

    const client = createEmailClient(BASE_CONFIG);
    await client.send({
      to: "user@example.com",
      subject: "Test",
      html: "<p>Test</p>",
    });

    const callArgs = mockSend.mock.calls[0] as unknown[];
    const sendParams = callArgs[0] as Record<string, unknown>;
    expect(sendParams.from).toBe("angel.campa@example.com");
  });

  it("uses explicit from when provided", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({ data: { id: "email-id-005" }, error: null });

    const client = createEmailClient(BASE_CONFIG);
    await client.send({
      to: "user@example.com",
      subject: "Test",
      html: "<p>Test</p>",
      from: "support@example.com",
    });

    const callArgs = mockSend.mock.calls[0] as unknown[];
    const sendParams = callArgs[0] as Record<string, unknown>;
    expect(sendParams.from).toBe("support@example.com");
  });

  it("re-throws Resend error as standard Error", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({
      data: null,
      error: { message: "API rate limit exceeded", name: "rate_limit_exceeded" },
    });

    const client = createEmailClient(BASE_CONFIG);
    await expect(
      client.send({ to: "user@example.com", subject: "Test", html: "<p>Test</p>" }),
    ).rejects.toThrow("Resend error: API rate limit exceeded");
  });

  it("throws when Resend returns no data and no error", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({ data: null, error: null });

    const client = createEmailClient(BASE_CONFIG);
    await expect(
      client.send({ to: "user@example.com", subject: "Test", html: "<p>Test</p>" }),
    ).rejects.toThrow("Resend returned no data and no error");
  });

  it("passes idempotencyKey to Resend when provided", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({ data: { id: "email-id-006" }, error: null });

    const client = createEmailClient(BASE_CONFIG);
    await client.send({
      to: "user@example.com",
      subject: "Test",
      html: "<p>Test</p>",
      idempotencyKey: "my-key-123",
    });

    // Second argument to send() should be the options with idempotencyKey
    const callArgs = mockSend.mock.calls[0] as unknown[];
    expect(callArgs[1]).toEqual({ idempotencyKey: "my-key-123" });
  });

  it("passes text, replyTo, and tags when provided", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({ data: { id: "email-id-010" }, error: null });

    const client = createEmailClient(BASE_CONFIG);
    await client.send({
      to: "user@example.com",
      subject: "Rich email",
      html: "<p>Content</p>",
      text: "Content",
      replyTo: "support@example.com",
      tags: [{ name: "category", value: "newsletter" }],
    });

    const callArgs = mockSend.mock.calls[0] as unknown[];
    const sendParams = callArgs[0] as Record<string, unknown>;
    expect(sendParams.text).toBe("Content");
    expect(sendParams.replyTo).toBe("support@example.com");
    expect(sendParams.tags).toEqual([{ name: "category", value: "newsletter" }]);
  });

  it("reuses the cached Resend instance on subsequent sends", async () => {
    const { mockSend, MockResend } = await getResendMocks();
    MockResend.mockClear();
    mockSend.mockResolvedValue({ data: { id: "email-id-011" }, error: null });

    const client = createEmailClient(BASE_CONFIG);
    await client.send({ to: "user@example.com", subject: "First", html: "<p>1</p>" });
    await client.send({ to: "user@example.com", subject: "Second", html: "<p>2</p>" });

    // Constructor called exactly once; both sends share the cached instance
    expect(MockResend).toHaveBeenCalledTimes(1);
    expect(MockResend).toHaveBeenCalledWith(BASE_CONFIG.resendApiKey);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe("EmailClient.sendIdempotent", () => {
  beforeEach(async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockReset();
  });

  it("constructs idempotencyKey from entityId and operationType", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({ data: { id: "email-id-007" }, error: null });

    const client = createEmailClient(BASE_CONFIG);
    const result = await client.sendIdempotent({
      to: "user@example.com",
      subject: "Welcome",
      html: "<p>Welcome!</p>",
      entityId: "user-789",
      operationType: "welcome-email",
    });

    expect(result.id).toBe("email-id-007");

    const callArgs = mockSend.mock.calls[0] as unknown[];
    expect(callArgs[1]).toEqual({ idempotencyKey: "user-789:welcome-email" });
  });

  it("does not pass entityId or operationType to Resend send params", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({ data: { id: "email-id-008" }, error: null });

    const client = createEmailClient(BASE_CONFIG);
    await client.sendIdempotent({
      to: "user@example.com",
      subject: "Test",
      html: "<p>Test</p>",
      entityId: "entity-1",
      operationType: "op-type",
    });

    const callArgs = mockSend.mock.calls[0] as unknown[];
    const sendParams = callArgs[0] as Record<string, unknown>;
    expect(sendParams).not.toHaveProperty("entityId");
    expect(sendParams).not.toHaveProperty("operationType");
  });

  it("also adds List-Unsubscribe headers when unsubscribeUrl present", async () => {
    const { mockSend } = await getResendMocks();
    mockSend.mockResolvedValue({ data: { id: "email-id-009" }, error: null });

    const client = createEmailClient(BASE_CONFIG);
    await client.sendIdempotent({
      to: "user@example.com",
      subject: "Marketing",
      html: "<p>Promo</p>",
      entityId: "user-001",
      operationType: "promo-march",
      unsubscribeUrl: "https://example.com/unsub?t=token",
    });

    const callArgs = mockSend.mock.calls[0] as unknown[];
    const sendParams = callArgs[0] as Record<string, unknown>;
    const headers = sendParams.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toBe("<https://example.com/unsub?t=token>");
  });
});
