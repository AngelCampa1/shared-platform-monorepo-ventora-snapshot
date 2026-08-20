# @ventora/api-client

Fetch-based API client factory with typed `ApiError`, automatic retry on GET, and a matching TanStack Query client factory.

## Install

```bash
pnpm add @ventora/api-client
```

## Usage

```ts
import { createApiClient, isNotFound } from "@ventora/api-client";

const api = createApiClient({ baseUrl: "https://api.example.com", retries: 2 });

try {
  const user = await api.get<{ id: string }>("/users/me");
} catch (err) {
  if (isNotFound(err)) {
    // handle 404
  }
}
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `createApiClient`, `ApiClient`/`ApiClientOpts`/`RequestOpts` types, `ApiError`, `isApiError`, `isNotFound`, `isUnauthorized`, `uploadFile`, `UploadFileOpts`/`UploadResult` types |
| `./query-client` | `createQueryClient`, `QueryClientOpts` type |

## Notes

- Retry only applies to `get`. `post`/`put`/`patch`/`del` fail on the first attempt, since retrying a non-idempotent write silently is the wrong default, and `downloadBlob` opts out too because a retried download restarts the whole transfer.
- `@tanstack/react-query` is an optional peer dependency, required only by `./query-client`.
- A `401` response triggers `onUnauthorized()` before the error is thrown, so a consumer can redirect to login or clear a session in one place.
