import { render as reactEmailRender } from "@react-email/render";
import * as React from "react";
import type { RenderResult, TemplateName, TemplateVars } from "./types.js";

import EmailVerification from "./templates/email-verification.js";
import InternalErrorFallback from "./templates/internal-error-fallback.js";
import LeadMagnetDelivery from "./templates/lead-magnet-delivery.js";
import NurtureStep from "./templates/nurture-step.js";
import PasswordReset from "./templates/password-reset.js";
import PaymentFailed from "./templates/payment-failed.js";
import PaymentReceipt from "./templates/payment-receipt.js";
import TrialEnding from "./templates/trial-ending.js";
import TrialExpired from "./templates/trial-expired.js";
import Welcome from "./templates/welcome.js";

const TEMPLATES: Record<TemplateName, React.ComponentType<Record<string, unknown>>> = {
  welcome: Welcome as React.ComponentType<Record<string, unknown>>,
  "password-reset": PasswordReset as React.ComponentType<Record<string, unknown>>,
  "email-verification": EmailVerification as React.ComponentType<Record<string, unknown>>,
  "trial-ending": TrialEnding as React.ComponentType<Record<string, unknown>>,
  "trial-expired": TrialExpired as React.ComponentType<Record<string, unknown>>,
  "payment-receipt": PaymentReceipt as React.ComponentType<Record<string, unknown>>,
  "payment-failed": PaymentFailed as React.ComponentType<Record<string, unknown>>,
  "lead-magnet-delivery": LeadMagnetDelivery as React.ComponentType<Record<string, unknown>>,
  "nurture-step": NurtureStep as React.ComponentType<Record<string, unknown>>,
  "internal-error-fallback": InternalErrorFallback as React.ComponentType<Record<string, unknown>>,
};

type RequiredTemplateVar = {
  name: string;
  type: "number" | "string";
};

const REQUIRED_VARS: Record<TemplateName, RequiredTemplateVar[]> = {
  welcome: [
    { name: "productName", type: "string" },
    { name: "loginUrl", type: "string" },
  ],
  "password-reset": [{ name: "resetUrl", type: "string" }],
  "email-verification": [{ name: "verifyUrl", type: "string" }],
  "trial-ending": [
    { name: "daysLeft", type: "number" },
    { name: "upgradeUrl", type: "string" },
    { name: "productName", type: "string" },
  ],
  "trial-expired": [
    { name: "upgradeUrl", type: "string" },
    { name: "productName", type: "string" },
  ],
  "payment-receipt": [
    { name: "amount", type: "string" },
    { name: "currency", type: "string" },
    { name: "planName", type: "string" },
    { name: "date", type: "string" },
  ],
  "payment-failed": [
    { name: "updatePaymentUrl", type: "string" },
    { name: "amount", type: "string" },
  ],
  "lead-magnet-delivery": [
    { name: "downloadUrl", type: "string" },
    { name: "resourceTitle", type: "string" },
    { name: "productName", type: "string" },
  ],
  "nurture-step": [
    { name: "subject", type: "string" },
    { name: "body", type: "string" },
    { name: "productName", type: "string" },
  ],
  "internal-error-fallback": [{ name: "supportEmail", type: "string" }],
};

export async function render(name: TemplateName, vars: TemplateVars): Promise<RenderResult> {
  const Component = TEMPLATES[name];
  if (!Component) throw new Error(`Unknown template: ${name}`);
  assertTemplateVars(name, vars);
  const element = React.createElement(Component, vars);
  const html = await reactEmailRender(element);
  const text = await reactEmailRender(element, { plainText: true });
  return { html, text };
}

function assertTemplateVars(name: TemplateName, vars: TemplateVars): void {
  for (const required of REQUIRED_VARS[name]) {
    if (!matchesRequiredType(vars[required.name], required.type)) {
      throw new Error(`Template "${name}" requires ${required.type} var "${required.name}"`);
    }
  }
}

function matchesRequiredType(value: unknown, type: RequiredTemplateVar["type"]): boolean {
  if (type === "number") {
    return typeof value === "number";
  }
  return typeof value === "string";
}
