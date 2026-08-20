# @ventora/auth-better

A `createAuth` factory over Better Auth with cookie/session defaults, plus request-guard helpers for route handlers.

## Install

```bash
pnpm add @ventora/auth-better
```

## Usage

```ts
import { createAuth, requireSession, AuthRequiredError } from "@ventora/auth-better";

const auth = createAuth({
  db,
  env: { BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET! },
  appUrl: "https://app.example.com",
});

export async function GET(request: Request) {
  try {
    const { user, session } = await requireSession(request, auth);
    return Response.json({ user });
  } catch (err) {
    if (err instanceof AuthRequiredError) return new Response("Unauthorized", { status: 401 });
    throw err;
  }
}
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `createAuth`, `requireSession`, `requireOrg`, `requireRole`, `AuthRequiredError`, `ForbiddenRoleError`, shared types (`AuthEnv`, `User`, `Session`, `Organization`, `Member`, `AuthContext`, `OrgAuthContext`, `BetterAuthInstance`, ...) |
| `./factory` | `createAuth`, `AuthFactoryOpts`, `CrossSubdomainCookieConfig` |
| `./helpers` | `requireSession`, `requireOrg`, `requireRole`, `AuthRequiredError`, `ForbiddenRoleError` |
| `./advanced` | `encryptedTokenPlugin`, `sessionIdleTimeoutPlugin`, `inviteSignupPlugin`, `auditableSessionPlugin`, `isVentoraPlugin`, `resolvePlugins` |

## Notes

- `better-auth` is a peer dependency. This package configures it, it does not bundle it.
- `./advanced` plugin descriptors validate their options, but `resolvePlugins()` throws for all four: each requires a product-owned Better Auth integration, so no no-op KMS/idle-timeout/invite/audit plugin ships here.
- `createAuth` throws at startup if `BETTER_AUTH_SECRET` is missing or under 32 characters.
