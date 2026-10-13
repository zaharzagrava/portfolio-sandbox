---
id: idempotency-key-required
title: idempotency_key_required (422)
kind: term
status: draft
aliases: [idempotency_key_required]
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# idempotency_key_required (422)
## Definition
`idempotency_key_required` is the `422` error that [`POST /payments/intents`](payment-intent.md) returns when the request has no [`Idempotency-Key` header](idempotency-key.md). The key is mandatory on this endpoint, and no payment is created without one. [Only `202` answers are remembered](idempotency-stored-answer.md), so this failure does not use up any key.

## Example
```
POST /payments/intents
(no Idempotency-Key header)
{"orderId": "ord_1", "paymentMethodId": "pm_1"}   (illustrative)
→ 422 idempotency_key_required
```

## Known gaps
- The spec does not say whether an empty or malformed key value counts as missing.
- The spec does not say whether this check runs before or after body validation and the [rate limit](rate-limit.md).

## Used by
<!-- used-by:start -->
- [idempotency-key](idempotency-key.md)
- [idempotency-stored-answer](idempotency-stored-answer.md)
- [rate-limit](rate-limit.md)
<!-- used-by:end -->
