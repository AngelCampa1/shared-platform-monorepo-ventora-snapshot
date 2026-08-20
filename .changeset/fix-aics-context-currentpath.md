---
"@ventora/ai-cs-worker": patch
---
Fix AI-CS context HMAC: sign the context request body as {appId,userId} only (currentPath stays a query param), matching every product verifier. Fixes chat 502 app_context_unavailable when the widget sends a currentPath.
