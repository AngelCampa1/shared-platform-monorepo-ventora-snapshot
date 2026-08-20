import { describe, expect, it } from "vitest";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
  buildInternalErrorBody,
  toUserFacingError,
} from "../errors.js";

describe("AppError", () => {
  it("sets status and message", () => {
    const err = new AppError(500, "Internal Server Error");
    expect(err.status).toBe(500);
    expect(err.message).toBe("Internal Server Error");
  });

  it("sets optional code", () => {
    const err = new AppError(400, "Bad input", "BAD_INPUT");
    expect(err.code).toBe("BAD_INPUT");
  });

  it("code is undefined when not provided", () => {
    const err = new AppError(500, "err");
    expect(err.code).toBeUndefined();
  });

  it("is an instance of Error", () => {
    expect(new AppError(500, "oops")).toBeInstanceOf(Error);
  });
});

describe("NotFoundError", () => {
  it("has status 404", () => {
    expect(new NotFoundError().status).toBe(404);
  });

  it("uses default message", () => {
    expect(new NotFoundError().message).toBe("Not found");
  });

  it("accepts custom message", () => {
    expect(new NotFoundError("User not found").message).toBe("User not found");
  });

  it("is an instance of AppError", () => {
    expect(new NotFoundError()).toBeInstanceOf(AppError);
  });
});

describe("UnauthorizedError", () => {
  it("has status 401", () => {
    expect(new UnauthorizedError().status).toBe(401);
  });

  it("uses default message", () => {
    expect(new UnauthorizedError().message).toBe("Unauthorized");
  });

  it("accepts custom message", () => {
    expect(new UnauthorizedError("Token expired").message).toBe("Token expired");
  });
});

describe("ForbiddenError", () => {
  it("has status 403", () => {
    expect(new ForbiddenError().status).toBe(403);
  });

  it("uses default message", () => {
    expect(new ForbiddenError().message).toBe("Forbidden");
  });

  it("accepts custom message", () => {
    expect(new ForbiddenError("Access denied").message).toBe("Access denied");
  });
});

describe("ValidationError", () => {
  it("has status 422", () => {
    expect(new ValidationError().status).toBe(422);
  });

  it("uses default message", () => {
    expect(new ValidationError().message).toBe("Validation failed");
  });

  it("accepts custom message and code", () => {
    const err = new ValidationError("Invalid email", "INVALID_EMAIL");
    expect(err.message).toBe("Invalid email");
    expect(err.code).toBe("INVALID_EMAIL");
  });
});

describe("ConflictError", () => {
  it("has status 409", () => {
    expect(new ConflictError().status).toBe(409);
  });

  it("uses default message", () => {
    expect(new ConflictError().message).toBe("Conflict");
  });

  it("accepts custom message", () => {
    expect(new ConflictError("Email already exists").message).toBe("Email already exists");
  });
});

describe("RateLimitError", () => {
  it("has status 429", () => {
    expect(new RateLimitError().status).toBe(429);
  });

  it("uses default message", () => {
    expect(new RateLimitError().message).toBe("Too many requests");
  });

  it("accepts custom message", () => {
    expect(new RateLimitError("Slow down").message).toBe("Slow down");
  });
});

describe("buildInternalErrorBody", () => {
  it("returns the standard error message", () => {
    const body = buildInternalErrorBody();
    expect(body.error).toBe("Something went wrong. Please try again.");
  });

  it("excludes trackingId when not provided", () => {
    const body = buildInternalErrorBody();
    expect("trackingId" in body).toBe(false);
  });

  it("includes trackingId when provided", () => {
    const body = buildInternalErrorBody("evt-abc-123");
    expect(body.trackingId).toBe("evt-abc-123");
  });

  it("includes trackingId in the shape when provided", () => {
    const body = buildInternalErrorBody("track-1");
    expect(body).toEqual({
      error: "Something went wrong. Please try again.",
      trackingId: "track-1",
    });
  });
});

describe("toUserFacingError", () => {
  it("returns message from AppError", () => {
    const err = new AppError(400, "Bad request");
    const result = toUserFacingError(err);
    expect(result.message).toBe("Bad request");
  });

  it("reportable is false for 4xx AppErrors", () => {
    expect(toUserFacingError(new NotFoundError()).reportable).toBe(false);
    expect(toUserFacingError(new UnauthorizedError()).reportable).toBe(false);
    expect(toUserFacingError(new ForbiddenError()).reportable).toBe(false);
    expect(toUserFacingError(new ValidationError()).reportable).toBe(false);
    expect(toUserFacingError(new ConflictError()).reportable).toBe(false);
    expect(toUserFacingError(new RateLimitError()).reportable).toBe(false);
  });

  it("reportable is true for 5xx AppErrors", () => {
    const err = new AppError(500, "Server error");
    expect(toUserFacingError(err).reportable).toBe(true);
  });

  it("reportable is true for AppError with status 500", () => {
    const err = new AppError(503, "Service unavailable");
    expect(toUserFacingError(err).reportable).toBe(true);
  });

  it("returns generic message for unknown errors", () => {
    const result = toUserFacingError(new Error("Raw error"));
    expect(result.message).toBe("Something went wrong. Please try again.");
    expect(result.reportable).toBe(true);
  });

  it("returns generic message for non-Error values", () => {
    expect(toUserFacingError("string error").message).toBe(
      "Something went wrong. Please try again.",
    );
    expect(toUserFacingError(null).message).toBe("Something went wrong. Please try again.");
    expect(toUserFacingError(42).reportable).toBe(true);
  });

  it("trackingId is undefined for unknown errors", () => {
    expect(toUserFacingError(new Error("e")).trackingId).toBeUndefined();
  });

  it("AppError result has no trackingId property", () => {
    const result = toUserFacingError(new NotFoundError());
    expect(result.trackingId).toBeUndefined();
  });
});
