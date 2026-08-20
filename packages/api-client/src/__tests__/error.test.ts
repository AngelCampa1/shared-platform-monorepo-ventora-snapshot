import { describe, expect, it } from "vitest";
import { ApiError, isApiError, isNotFound, isUnauthorized } from "../error.js";

describe("ApiError constructor", () => {
  it("sets all fields from opts", () => {
    const err = new ApiError({
      status: 422,
      message: "Validation failed",
      body: { field: "email" },
      requestId: "req-123",
      correlationId: "corr-456",
      errorCode: "INVALID_EMAIL",
    });

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ApiError");
    expect(err.status).toBe(422);
    expect(err.message).toBe("Validation failed");
    expect(err.displayMessage).toBe("Validation failed");
    expect(err.body).toEqual({ field: "email" });
    expect(err.requestId).toBe("req-123");
    expect(err.correlationId).toBe("corr-456");
    expect(err.errorCode).toBe("INVALID_EMAIL");
  });

  it("uses HTTP status as message when message is not provided", () => {
    const err = new ApiError({ status: 503 });
    expect(err.message).toBe("HTTP 503");
    expect(err.displayMessage).toBe("HTTP 503");
  });

  it("leaves optional fields undefined when not provided", () => {
    const err = new ApiError({ status: 400, message: "Bad request" });
    expect(err.body).toBeUndefined();
    expect(err.requestId).toBeUndefined();
    expect(err.correlationId).toBeUndefined();
    expect(err.errorCode).toBeUndefined();
  });
});

describe("ApiError.fromResponse", () => {
  it("parses JSON body and extracts message", async () => {
    const res = new Response(JSON.stringify({ message: "Not found", code: "NOT_FOUND" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    const err = await ApiError.fromResponse(res);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Not found");
    expect(err.errorCode).toBe("NOT_FOUND");
    expect(err.body).toEqual({ message: "Not found", code: "NOT_FOUND" });
  });

  it("extracts errorCode from body.errorCode when body.code is absent", async () => {
    const res = new Response(JSON.stringify({ message: "Forbidden", errorCode: "FORBIDDEN_OP" }), {
      status: 403,
    });
    const err = await ApiError.fromResponse(res);
    expect(err.errorCode).toBe("FORBIDDEN_OP");
  });

  it("uses body.error when body.message is absent", async () => {
    const res = new Response(JSON.stringify({ error: "Something broke" }), { status: 500 });
    const err = await ApiError.fromResponse(res);
    expect(err.message).toBe("Something broke");
  });

  it("extracts requestId from x-request-id header", async () => {
    const res = new Response(JSON.stringify({}), {
      status: 400,
      headers: { "x-request-id": "req-abc" },
    });
    const err = await ApiError.fromResponse(res);
    expect(err.requestId).toBe("req-abc");
  });

  it("extracts correlationId from x-correlation-id header", async () => {
    const res = new Response(JSON.stringify({}), {
      status: 400,
      headers: { "x-correlation-id": "corr-xyz" },
    });
    const err = await ApiError.fromResponse(res);
    expect(err.correlationId).toBe("corr-xyz");
  });

  it("falls back to text body when JSON parse fails", async () => {
    const res = new Response("plain text error", { status: 502 });
    const err = await ApiError.fromResponse(res);
    expect(err.body).toBe("plain text error");
    expect(err.message).toBe("plain text error");
  });

  it("uses HTTP status as message when body has no message fields", async () => {
    const res = new Response(JSON.stringify({ data: "other" }), { status: 418 });
    const err = await ApiError.fromResponse(res);
    expect(err.message).toBe("HTTP 418");
  });

  it("uses HTTP status as message when body is empty text", async () => {
    const res = new Response("", { status: 500 });
    const err = await ApiError.fromResponse(res);
    expect(err.message).toBe("HTTP 500");
  });
});

describe("isApiError", () => {
  it("returns true for ApiError instances", () => {
    expect(isApiError(new ApiError({ status: 400 }))).toBe(true);
  });

  it("returns false for regular Error", () => {
    expect(isApiError(new Error("oops"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isApiError(null)).toBe(false);
  });

  it("returns false for plain objects", () => {
    expect(isApiError({ status: 404 })).toBe(false);
  });
});

describe("isNotFound", () => {
  it("returns true for ApiError with status 404", () => {
    expect(isNotFound(new ApiError({ status: 404 }))).toBe(true);
  });

  it("returns false for ApiError with status 403", () => {
    expect(isNotFound(new ApiError({ status: 403 }))).toBe(false);
  });

  it("returns false for non-ApiError", () => {
    expect(isNotFound(new Error("not found"))).toBe(false);
  });
});

describe("isUnauthorized", () => {
  it("returns true for ApiError with status 401", () => {
    expect(isUnauthorized(new ApiError({ status: 401 }))).toBe(true);
  });

  it("returns false for ApiError with status 403", () => {
    expect(isUnauthorized(new ApiError({ status: 403 }))).toBe(false);
  });

  it("returns false for non-ApiError", () => {
    expect(isUnauthorized(new Error("unauthorized"))).toBe(false);
  });
});
