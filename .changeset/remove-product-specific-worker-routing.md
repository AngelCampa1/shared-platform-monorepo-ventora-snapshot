---
"@ventora/ai-sdr-worker": patch
"@ventora/ai-cs-worker": patch
---

Remove a product-specific origin, endpoint routing, and hosted-profile special case from the shared AI Workers in favour of the generic per-product routing path, while preserving behavior for all other products.
