import { ApiError } from "./error.js";

export type RequestOpts = {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export interface ApiClient {
  get<T>(path: string, opts?: RequestOpts): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: RequestOpts): Promise<T>;
  put<T>(path: string, body?: unknown, opts?: RequestOpts): Promise<T>;
  patch<T>(path: string, body?: unknown, opts?: RequestOpts): Promise<T>;
  del<T>(path: string, opts?: RequestOpts): Promise<T>;
  downloadBlob(path: string, opts?: RequestOpts): Promise<Blob>;
}

export type ApiClientOpts = {
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  authProvider?: () => Promise<{ token?: string } | null>;
  onUnauthorized?: () => void | Promise<void>;
  sentryCapture?: (err: unknown, ctx: Record<string, unknown>) => string | undefined;
};

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function mergeSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (secondary === undefined) {
    return primary;
  }
  return AbortSignal.any([primary, secondary]);
}

const RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createApiClient(opts: ApiClientOpts): ApiClient {
  const defaultTimeoutMs = opts.timeoutMs ?? 30_000;
  const maxRetries = Math.max(0, opts.retries ?? 1);

  async function buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extra,
    };

    if (opts.authProvider) {
      const auth = await opts.authProvider();
      if (auth?.token) {
        headers.Authorization = `Bearer ${auth.token}`;
      }
    }

    return headers;
  }

  async function executeRequest(
    method: string,
    path: string,
    body?: unknown,
    reqOpts?: RequestOpts,
    retryable = false,
  ): Promise<Response> {
    const timeoutMs = reqOpts?.timeoutMs ?? defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = mergeSignals(timeoutSignal, reqOpts?.signal);
    const headers = await buildHeaders(reqOpts?.headers);
    const url = joinUrl(opts.baseUrl, path);

    const fetchOpts: RequestInit = {
      method,
      headers,
      signal,
    };

    if (body !== undefined) {
      fetchOpts.body = JSON.stringify(body);
    } else {
      // No Content-Type needed for requests without a body
      const { "Content-Type": _contentType, ...headersWithoutContentType } = headers;
      fetchOpts.headers = headersWithoutContentType;
    }

    let lastError: unknown;
    const attempts = retryable ? maxRetries + 1 : 1;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_DELAY_MS);
      }

      let res: Response;
      try {
        res = await fetch(url, fetchOpts);
      } catch (err) {
        lastError = err;
        if (retryable && attempt < attempts - 1) {
          continue;
        }
        throw err;
      }

      if (res.status === 401) {
        if (opts.onUnauthorized) {
          await opts.onUnauthorized();
        }
        const apiErr = await ApiError.fromResponse(res);
        throw apiErr;
      }

      if (!res.ok) {
        const apiErr = await ApiError.fromResponse(res);
        if (opts.sentryCapture) {
          opts.sentryCapture(apiErr, { method, url, status: res.status });
        }
        if (retryable && res.status >= 500 && attempt < attempts - 1) {
          lastError = apiErr;
          continue;
        }
        throw apiErr;
      }

      return res;
    }

    throw lastError;
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    reqOpts?: RequestOpts,
    retryable = false,
  ): Promise<T> {
    const res = await executeRequest(method, path, body, reqOpts, retryable);
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T;
    }
    return res.json() as Promise<T>;
  }

  return {
    get<T>(path: string, reqOpts?: RequestOpts): Promise<T> {
      return request<T>("GET", path, undefined, reqOpts, true);
    },
    post<T>(path: string, body?: unknown, reqOpts?: RequestOpts): Promise<T> {
      return request<T>("POST", path, body, reqOpts, false);
    },
    put<T>(path: string, body?: unknown, reqOpts?: RequestOpts): Promise<T> {
      return request<T>("PUT", path, body, reqOpts, false);
    },
    patch<T>(path: string, body?: unknown, reqOpts?: RequestOpts): Promise<T> {
      return request<T>("PATCH", path, body, reqOpts, false);
    },
    del<T>(path: string, reqOpts?: RequestOpts): Promise<T> {
      return request<T>("DELETE", path, undefined, reqOpts, false);
    },
    async downloadBlob(path: string, reqOpts?: RequestOpts): Promise<Blob> {
      const res = await executeRequest("GET", path, undefined, reqOpts, false);
      return res.blob();
    },
  };
}
