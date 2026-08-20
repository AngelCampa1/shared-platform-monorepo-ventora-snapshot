import { describe, expect, it } from "vitest";
import { render } from "../render.js";
import type { TemplateName } from "../types.js";

describe("render()", () => {
  it("renders welcome template with expected content", async () => {
    const result = await render("welcome", {
      productName: "Lextract",
      firstName: "Alice",
      loginUrl: "https://lextract.app/login",
      trialDays: 14,
    });
    expect(result.html).toContain("Lextract");
    expect(result.html).toContain("Alice");
    expect(result.html).toContain("https://lextract.app/login");
    expect(result.html).toContain("14");
  });

  it("renders password-reset template with reset URL", async () => {
    const result = await render("password-reset", {
      resetUrl: "https://app.example.com/reset?token=abc123",
      firstName: "Bob",
    });
    expect(result.html).toContain("https://app.example.com/reset?token=abc123");
    expect(result.html).toContain("Bob");
  });

  it("rejects password-reset without resetUrl", async () => {
    await expect(render("password-reset", {})).rejects.toThrow(
      'Template "password-reset" requires string var "resetUrl"',
    );
  });

  it("throws for unknown template name", async () => {
    await expect(render("nonexistent-template" as TemplateName, {})).rejects.toThrow(
      /Unknown template: nonexistent-template/,
    );
  });

  it("text output contains no HTML tags", async () => {
    const result = await render("welcome", {
      productName: "TestProduct",
      firstName: "Jane",
      loginUrl: "https://example.com/login",
    });
    expect(result.text).not.toMatch(/<[a-z][\s\S]*>/i);
  });

  it("html output contains HTML structure", async () => {
    const result = await render("welcome", {
      productName: "TestProduct",
      firstName: "Jane",
      loginUrl: "https://example.com/login",
    });
    expect(result.html).toMatch(/<html/i);
  });

  // Smoke test all 10 templates
  const ALL_TEMPLATES: { name: TemplateName; vars: Record<string, unknown> }[] = [
    {
      name: "welcome",
      vars: { productName: "Acme", firstName: "Alex", loginUrl: "https://acme.io/login" },
    },
    {
      name: "password-reset",
      vars: { resetUrl: "https://acme.io/reset?t=tok" },
    },
    {
      name: "email-verification",
      vars: { verifyUrl: "https://acme.io/verify?t=tok" },
    },
    {
      name: "trial-ending",
      vars: { daysLeft: 3, upgradeUrl: "https://acme.io/upgrade", productName: "Acme" },
    },
    {
      name: "trial-expired",
      vars: { upgradeUrl: "https://acme.io/upgrade", productName: "Acme" },
    },
    {
      name: "payment-receipt",
      vars: { amount: "49.00", currency: "USD", planName: "Pro", date: "2026-05-01" },
    },
    {
      name: "payment-failed",
      vars: { updatePaymentUrl: "https://acme.io/billing", amount: "$49.00" },
    },
    {
      name: "lead-magnet-delivery",
      vars: {
        downloadUrl: "https://acme.io/dl/guide.pdf",
        resourceTitle: "The Ultimate Guide",
        productName: "Acme",
      },
    },
    {
      name: "nurture-step",
      vars: {
        subject: "3 tips to get started",
        body: "Here are your tips...",
        productName: "Acme",
      },
    },
    {
      name: "internal-error-fallback",
      vars: { supportEmail: "support@acme.io" },
    },
  ];

  for (const { name, vars } of ALL_TEMPLATES) {
    it(`smoke: "${name}" renders without throwing`, async () => {
      const result = await render(name, vars);
      expect(result.html).toBeTruthy();
      expect(result.text).toBeTruthy();
    });
  }

  it("renders trial-ending with singular 'day' for daysLeft=1", async () => {
    const result = await render("trial-ending", {
      daysLeft: 1,
      upgradeUrl: "https://example.com/upgrade",
      productName: "Acme",
    });
    expect(result.html).toContain("1 day");
  });

  it("renders payment-receipt without invoice button when invoiceUrl absent", async () => {
    const result = await render("payment-receipt", {
      amount: "99.00",
      currency: "USD",
      planName: "Enterprise",
      date: "2026-05-01",
    });
    expect(result.html).toContain("99.00");
    expect(result.html).not.toContain("Download Invoice");
  });

  it("renders payment-receipt with invoice button when invoiceUrl present", async () => {
    const result = await render("payment-receipt", {
      amount: "99.00",
      currency: "USD",
      planName: "Enterprise",
      date: "2026-05-01",
      invoiceUrl: "https://stripe.com/invoice/abc",
    });
    expect(result.html).toContain("Download Invoice");
    expect(result.html).toContain("https://stripe.com/invoice/abc");
  });

  it("renders nurture-step with CTA when ctaUrl provided", async () => {
    const result = await render("nurture-step", {
      subject: "Step 2 of 5",
      body: "Here is some content",
      ctaUrl: "https://example.com/step2",
      ctaText: "Continue Reading",
      productName: "Acme",
    });
    expect(result.html).toContain("Continue Reading");
    expect(result.html).toContain("https://example.com/step2");
  });

  it("renders internal-error-fallback with tracking ID when provided", async () => {
    const result = await render("internal-error-fallback", {
      trackingId: "err-abc-123",
      supportEmail: "support@example.com",
    });
    expect(result.html).toContain("err-abc-123");
    expect(result.html).toContain("support@example.com");
  });
});
