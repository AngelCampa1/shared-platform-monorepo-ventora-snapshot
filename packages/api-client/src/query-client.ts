import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./error.js";

export type QueryClientOpts = {
  staleTime?: number;
  gcTime?: number;
  retries?: number;
  onError?: (err: unknown) => void;
};

export function createQueryClient(opts?: QueryClientOpts): QueryClient {
  const staleTime = opts?.staleTime ?? 60_000;
  const gcTime = opts?.gcTime ?? 300_000;
  const maxRetries = opts?.retries ?? 1;

  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime,
        gcTime,
        retry: (failureCount, err) => {
          if (isApiError(err)) {
            return err.status >= 500 ? failureCount < maxRetries : false;
          }
          return failureCount < maxRetries;
        },
      },
      mutations: {
        retry: false,
        ...(opts?.onError !== undefined ? { onError: opts.onError } : {}),
      },
    },
  });
}
