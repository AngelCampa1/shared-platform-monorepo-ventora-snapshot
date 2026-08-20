export type TemplateName =
  | "welcome"
  | "password-reset"
  | "email-verification"
  | "trial-ending"
  | "trial-expired"
  | "payment-receipt"
  | "payment-failed"
  | "lead-magnet-delivery"
  | "nurture-step"
  | "internal-error-fallback";

export type TemplateVars = Record<string, unknown>;
export type RenderResult = { html: string; text: string };
