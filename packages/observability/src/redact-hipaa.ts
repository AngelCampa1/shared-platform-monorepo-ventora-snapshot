import { DEFAULT_RULES, redact } from "./redact.js";
import type { RedactionRules } from "./redact.js";

export { redact };
export type { RedactionRules };

/**
 * Combined HIPAA-18 + base redaction rules.
 * HIPAA-specific patterns are applied first so that structured identifiers
 * (MRN, NPI, DEA) are matched before more-general patterns like phone numbers.
 */
export const HIPAA_RULES: RedactionRules = {
  fieldKeys: DEFAULT_RULES.fieldKeys,
  patterns: [...DEFAULT_RULES.hipaa18Extensions, ...DEFAULT_RULES.patterns],
  hipaa18Extensions: DEFAULT_RULES.hipaa18Extensions,
  keyPatterns: DEFAULT_RULES.keyPatterns,
};
