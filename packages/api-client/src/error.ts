export class ApiError extends Error {
  readonly status: number;
  readonly body?: unknown;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly errorCode?: string;
  readonly displayMessage: string;

  constructor(opts: {
    status: number;
    message?: string;
    body?: unknown;
    requestId?: string;
    correlationId?: string;
    errorCode?: string;
  }) {
    const msg = opts.message ?? `HTTP ${opts.status}`;
    super(msg);
    this.name = "ApiError";
    this.status = opts.status;
    this.displayMessage = msg;
    if (opts.body !== undefined) this.body = opts.body;
    if (opts.requestId !== undefined) this.requestId = opts.requestId;
    if (opts.correlationId !== undefined) this.correlationId = opts.correlationId;
    if (opts.errorCode !== undefined) this.errorCode = opts.errorCode;
  }

  static async fromResponse(res: Response): Promise<ApiError> {
    const rawRequestId = res.headers.get("x-request-id");
    const rawCorrelationId = res.headers.get("x-correlation-id");

    let body: unknown;
    let message: string | undefined;
    let errorCode: string | undefined;

    const text = await res.text();
    try {
      body = JSON.parse(text) as unknown;
      if (body !== null && typeof body === "object") {
        const b = body as Record<string, unknown>;
        if (typeof b.message === "string") {
          message = b.message;
        } else if (typeof b.error === "string") {
          message = b.error;
        }
        if (typeof b.code === "string") {
          errorCode = b.code;
        } else if (typeof b.errorCode === "string") {
          errorCode = b.errorCode;
        }
      }
    } catch {
      body = text;
      if (text.length > 0) {
        message = text;
      }
    }

    return new ApiError({
      status: res.status,
      message: message ?? `HTTP ${res.status}`,
      body,
      ...(rawRequestId !== null ? { requestId: rawRequestId } : {}),
      ...(rawCorrelationId !== null ? { correlationId: rawCorrelationId } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    });
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function isNotFound(err: unknown): err is ApiError {
  return isApiError(err) && err.status === 404;
}

export function isUnauthorized(err: unknown): err is ApiError {
  return isApiError(err) && err.status === 401;
}
