/**
 * Base application error with an HTTP status code and optional error code.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", code?: string) {
    super(422, message, code);
    this.name = "ValidationError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(409, message);
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests") {
    super(429, message);
    this.name = "RateLimitError";
  }
}

export type InternalErrorBody = { error: string; trackingId?: string };

/**
 * Builds a generic internal server error response body, optionally including
 * a tracking ID for correlation with Sentry events.
 */
export function buildInternalErrorBody(trackingId?: string): InternalErrorBody {
  return {
    error: "Something went wrong. Please try again.",
    ...(trackingId !== undefined ? { trackingId } : {}),
  };
}

export type UserFacingError = {
  message: string;
  trackingId?: string;
  reportable: boolean;
};

/**
 * Converts any thrown value into a user-facing error descriptor.
 * AppError instances expose their message; unknown errors produce a generic
 * message and are always marked reportable.
 */
export function toUserFacingError(err: unknown): UserFacingError {
  if (err instanceof AppError) {
    return {
      message: err.message,
      reportable: err.status >= 500,
    };
  }
  return {
    message: "Something went wrong. Please try again.",
    reportable: true,
  };
}
