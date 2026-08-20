export type {
  SentryCloudflareEnv,
  SentryNodeOpts,
  ErrorCaptureContext,
} from "./sentry.js";
export {
  initSentryCloudflare,
  initSentryNode,
  captureException,
  captureMessage,
} from "./sentry.js";

export {
  withCorrelationId,
  getCorrelationId,
  generateRequestId,
  isValidRequestId,
} from "./correlation.js";

export {
  AppError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError,
  RateLimitError,
  buildInternalErrorBody,
  toUserFacingError,
} from "./errors.js";
export type { InternalErrorBody, UserFacingError } from "./errors.js";

export { redact, DEFAULT_RULES } from "./redact.js";
export type { PatternRule, KeyPatternRule, RedactionRules } from "./redact.js";
