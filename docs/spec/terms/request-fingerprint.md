---
id: request-fingerprint
title: Request fingerprint
kind: term
status: draft
aliases: [fingerprint]
defined_for: S10-cart-checkout
rules_hash: a5e59133aad3
---
# Request fingerprint
## Definition
The request fingerprint is the value that [idempotency handling](idempotency-key.md) compares to decide whether two [`POST /checkout`](post-checkout.md) requests with the same idempotency key have "the same body". If the fingerprints match, [the stored answer is replayed](idempotency-stored-answer.md). If they differ, the request is rejected as [`idempotency_key_reuse`](idempotency-key-reuse.md). The optional [`refCode`](referral-code.md) is part of the fingerprint, so changing only the referral code counts as a different request.

## Example
These are two `POST /checkout` calls from the same buyer with `Idempotency-Key: 7f3c9a12-checkout` (an illustrative value):
- The first sends `"refCode": "SPRING_24"` and an order is created.
- The second sends the same body but `"refCode": "SUMMER_24"` and gets `422 idempotency_key_reuse`.

## Known gaps
- The spec does not say which body fields and headers make up the fingerprint, apart from `refCode`.
- The spec does not say whether field order or whitespace changes the fingerprint.
- Not confirmed in the code: the fingerprint is probably what the spec calls the "request hash", which is an internal field and is never returned.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-47
- [S13](../capabilities/S13-payment-intents.md): B-02
- [get-order-by-id](get-order-by-id.md)
- [idempotency-key](idempotency-key.md)
- [idempotency-stored-answer](idempotency-stored-answer.md)
<!-- used-by:end -->
