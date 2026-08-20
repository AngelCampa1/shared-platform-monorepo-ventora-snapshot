# @ventora/email

Resend email client with idempotent sends, HMAC-signed unsubscribe tokens, and CAN-SPAM compliance checks.

## Install

```bash
pnpm add @ventora/email
```

## Usage

```ts
import { createEmailClient, generateUnsubscribeToken } from "@ventora/email";

const email = createEmailClient({
  resendApiKey: process.env.RESEND_API_KEY!,
  defaultFrom: "Acme <no-reply@example.com>",
  postalAddress: "123 Main St, City, ST 00000",
});

const token = await generateUnsubscribeToken("user_42", "marketing", process.env.UNSUB_SECRET!);

await email.send({
  to: "buyer@example.com",
  subject: "Welcome",
  html: "<p>Hi!</p>",
  unsubscribeUrl: `https://app.example.com/unsubscribe?token=${token}`,
});
```

## Exports

| Path | Contents |
| --- | --- |
| `.` | `createEmailClient`, `EmailClient`/`EmailSendParams`/`EmailSendResult`/`EmailClientConfig` types, `generateUnsubscribeToken`, `verifyUnsubscribeToken`, `UnsubscribeCategory` type, `assertCanSpamCompliance`, `buildListUnsubscribeHeaders`, `CanSpamConfig` type |

## Notes

- `resend` is an optional peer dependency, loaded via dynamic `import()` on first send.
- `createEmailClient` throws at construction if `postalAddress` is blank or looks like a placeholder (contains `[...]`, "placeholder", or "todo"). CAN-SPAM compliance is enforced, not just documented.
- `sendIdempotent` derives its Resend idempotency key from `entityId:operationType`, so retrying the same logical send (e.g. a webhook redelivery) never double-sends.
