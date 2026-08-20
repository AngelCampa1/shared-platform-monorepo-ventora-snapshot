export type PatternRule = { name: string; pattern: string; replacement: string };
export type KeyPatternRule = {
  name: string;
  pattern: string;
  replacement: string;
};
export type RedactionRules = {
  patterns: PatternRule[];
  hipaa18Extensions?: PatternRule[];
  fieldKeys: string[];
  keyPatterns: KeyPatternRule[];
};
type DefaultRedactionRules = RedactionRules & { hipaa18Extensions: PatternRule[] };

/**
 * Base redaction rules sourced from schemas/redaction-rules.json.
 * Inlined here to remain runtime-agnostic (no fs/fetch needed).
 */
export const DEFAULT_RULES: DefaultRedactionRules = {
  fieldKeys: [
    "password",
    "passwd",
    "secret",
    "token",
    "apiKey",
    "api_key",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "authToken",
    "auth_token",
    "authorization",
    "cookie",
    "sessionId",
    "session_id",
    "creditCard",
    "credit_card",
    "cardNumber",
    "card_number",
    "cvv",
    "ssn",
    "socialSecurityNumber",
    "social_security_number",
    "dateOfBirth",
    "date_of_birth",
    "dob",
    "bankAccount",
    "bank_account",
    "routingNumber",
    "routing_number",
    "privateKey",
    "private_key",
    "webhookSecret",
    "webhook_secret",
  ],
  patterns: [
    {
      name: "jwt",
      pattern: "eyJ[A-Za-z0-9_\\-]{10,}\\.eyJ[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}",
      replacement: "[jwt]",
    },
    {
      name: "bearer_token",
      pattern: "(?i)bearer\\s+[A-Za-z0-9\\-._~+/]+=*",
      replacement: "Bearer [token]",
    },
    {
      name: "credit_card",
      pattern:
        "\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\\b",
      replacement: "[credit-card]",
    },
    {
      name: "ssn",
      pattern: "\\b(?!000|666|9\\d{2})\\d{3}[\\s\\-](?!00)\\d{2}[\\s\\-](?!0000)\\d{4}\\b",
      replacement: "[ssn]",
    },
    {
      name: "email",
      pattern: "[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}",
      replacement: "[email]",
    },
    {
      name: "phone_us",
      pattern: "(?:\\+1[\\s\\-.]?)?(?:\\(?[0-9]{3}\\)?[\\s\\-.]?)[0-9]{3}[\\s\\-.]?[0-9]{4}",
      replacement: "[phone]",
    },
    {
      name: "ipv4",
      pattern:
        "\\b(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\b",
      replacement: "[ip]",
    },
  ],
  hipaa18Extensions: [
    {
      name: "mrn",
      pattern: "(?i)\\bMRN[:\\s#]*[A-Z0-9\\-]{4,20}\\b",
      replacement: "[mrn]",
    },
    {
      name: "npi",
      pattern: "(?i)\\bNPI[:\\s#]*[0-9]{10}\\b",
      replacement: "[npi]",
    },
    {
      name: "dea",
      pattern: "(?i)\\bDEA[:\\s#]*[A-Z]{2}[0-9]{7}\\b",
      replacement: "[dea]",
    },
    {
      name: "date_of_service",
      pattern:
        "(?i)\\b(?:DOS|date[_\\s]of[_\\s]service)[:\\s]*\\d{1,2}[/\\-]\\d{1,2}[/\\-]\\d{2,4}\\b",
      replacement: "[date-of-service]",
    },
  ],
  keyPatterns: [
    {
      name: "sensitive_suffix",
      pattern: "(?i)(secret|token|password|key|auth|credential)$",
      replacement: "[redacted]",
    },
  ],
};

// Compile patterns once at module init time
const _compiledPatterns: Array<{ re: RegExp; replacement: string }> = [
  ...DEFAULT_RULES.hipaa18Extensions,
  ...DEFAULT_RULES.patterns,
].map((r) => ({
  re: buildPatternRegex(r.pattern),
  replacement: r.replacement,
}));

const _compiledKeyPatterns: Array<{ re: RegExp; replacement: string }> =
  DEFAULT_RULES.keyPatterns.map((r) => ({
    re: buildPatternRegex(r.pattern),
    replacement: r.replacement,
  }));

const _fieldKeySet: Set<string> = new Set(DEFAULT_RULES.fieldKeys.map((k) => k.toLowerCase()));

function buildPatternRegex(pattern: string): RegExp {
  // Strip inline (?i) flag prefix — JavaScript uses /i flag instead
  let flags = "g";
  let src = pattern;
  if (src.startsWith("(?i)")) {
    src = src.slice(4);
    flags = "gi";
  }
  return new RegExp(src, flags);
}

function applyStringRedaction(
  value: string,
  compiledPatterns: Array<{ re: RegExp; replacement: string }>,
): string {
  let result = value;
  for (const { re, replacement } of compiledPatterns) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0;
    result = result.replace(re, replacement);
  }
  return result;
}

/**
 * Recursively redacts PII from `value` using the provided rules.
 * - Strings: pattern replacements are applied.
 * - Object keys matching fieldKeys (case-insensitive) → value replaced with "[redacted]".
 * - Object keys matching keyPatterns (regex) → value replaced with the pattern's replacement.
 * - All other object values and array elements are redacted recursively.
 *
 * Pass custom `rules` to override the defaults. When omitted, the runtime
 * default applies HIPAA extension patterns before DEFAULT_RULES.
 */
export function redact(value: unknown, rules?: RedactionRules): unknown {
  if (rules !== undefined) {
    return redactWithRules(value, rules);
  }
  return redactWithCompiled(value, _compiledPatterns, _compiledKeyPatterns, _fieldKeySet);
}

function redactWithRules(value: unknown, rules: RedactionRules): unknown {
  const compiledPatterns = [...(rules.hipaa18Extensions ?? []), ...rules.patterns].map((r) => ({
    re: buildPatternRegex(r.pattern),
    replacement: r.replacement,
  }));
  const compiledKeyPatterns = rules.keyPatterns.map((r) => ({
    re: buildPatternRegex(r.pattern),
    replacement: r.replacement,
  }));
  const fieldKeySet = new Set(rules.fieldKeys.map((k) => k.toLowerCase()));
  return redactWithCompiled(value, compiledPatterns, compiledKeyPatterns, fieldKeySet);
}

function redactWithCompiled(
  value: unknown,
  compiledPatterns: Array<{ re: RegExp; replacement: string }>,
  compiledKeyPatterns: Array<{ re: RegExp; replacement: string }>,
  fieldKeySet: Set<string>,
): unknown {
  if (typeof value === "string") {
    return applyStringRedaction(value, compiledPatterns);
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      redactWithCompiled(item, compiledPatterns, compiledKeyPatterns, fieldKeySet),
    );
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lowerKey = k.toLowerCase();

      if (fieldKeySet.has(lowerKey)) {
        result[k] = "[redacted]";
        continue;
      }

      let matchedKeyPattern = false;
      for (const { re, replacement } of compiledKeyPatterns) {
        re.lastIndex = 0;
        if (re.test(k)) {
          result[k] = replacement;
          matchedKeyPattern = true;
          break;
        }
      }
      if (matchedKeyPattern) continue;

      result[k] = redactWithCompiled(v, compiledPatterns, compiledKeyPatterns, fieldKeySet);
    }
    return result;
  }

  return value;
}
