# ventora-email

Transactional email client (Resend) with CAN-SPAM compliance checks, unsubscribe tokens, and template rendering via the `@ventora/email-renderer` Worker.

## Install

```bash
uv add ventora-email
```

## Usage

```python
from ventora_email import EmailClientConfig, create_email_client

client = create_email_client(
    EmailClientConfig(
        resend_api_key="re_...",
        default_from="notifications@example.com",
        postal_address="123 Main St, Springfield",
        renderer_url="https://ventora-email-renderer.example.workers.dev",
        renderer_hmac_secret="...",
    )
)

result = client.send_template(
    template="welcome",
    template_vars={"name": "Alice"},
    to="alice@example.com",
    subject="Welcome to the app",
)
print(result.id)
```

## Notes
- `EmailClient` cannot run Python. `send_template` calls `TemplateRenderer.render`, which POSTs to `@ventora/email-renderer`'s `POST /render` endpoint over HTTP because React Email templates only render in a JS runtime. When `renderer_hmac_secret` is set, the request is signed with an HMAC over `{timestamp, nonce, method, path, body}` (matching the Worker's verification).
- `EmailClient.__init__` calls `assert_can_spam_compliance(postal_address)` eagerly, so a client with a missing/invalid physical postal address fails at construction rather than at send time.
- `send_idempotent` derives a Resend `Idempotency-Key` from `f"{entity_id}:{operation_type}"` so retried sends of the same logical event do not double-send.
