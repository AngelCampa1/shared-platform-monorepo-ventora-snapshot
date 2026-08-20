# ventora-observability

Shared FastAPI-friendly error types, request correlation IDs, PII-scrubbing structured logging, and Sentry helpers.

## Install

```bash
uv add ventora-observability
```

## Usage

```python
from ventora_observability import (
    NotFoundError,
    configure_logger,
    generate_request_id,
    set_correlation_id,
    to_user_facing_error,
)

logger = configure_logger(level="INFO", use_json=True, logger_name="myapp")
set_correlation_id(generate_request_id())

try:
    raise NotFoundError("Account not found")
except NotFoundError as err:
    logger.error("lookup failed", extra={"user_id": "u_1"})
    body = to_user_facing_error(err)  # {"message": "Account not found", "reportable": False}
```

## Notes
- `configure_logger` attaches `SensitiveDataFilter`, which scrubs JWTs, `Bearer ...` tokens, and email addresses from log messages via regex, and redacts any extra field whose key looks like `password`/`token`/`api_key`/`authorization`/`cookie`/etc. before the record is formatted.
- `AppError` and its subclasses (`NotFoundError`, `UnauthorizedError`, `ForbiddenError`, `ValidationError`, `ConflictError`, `RateLimitError`) each carry a fixed HTTP `status`; `make_fastapi_exception_handler()` returns a ready-to-register FastAPI handler and returns `None` if `fastapi` is not installed.
- `to_user_facing_error` only marks an error `reportable` when its status is >= 500, so expected 4xx errors are not flagged as incidents.
