---
id: get-payments
title: GET /payments
kind: term
status: draft
aliases: [/payments]
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# GET /payments
## Definition
`GET /payments` lets an authenticated buyer list their own payments, newest first. It pages with a [signed keyset cursor](pagination-cursor.md) (built by `[encodePaymentCursor](encode-cursor.md)`). Paging never repeats or skips a payment, even when new payments are added between pages. A tampered cursor is rejected with `[invalid_cursor](invalid-cursor.md)`. An [`orderId`](order-id.md) filter only searches the caller's own payments, so another buyer's order gives an empty page. It is a plain [`Firewall()`](firewall-route.md) route with no [revocation check against Redis](session-revocation.md). Its [rate limit fails open](rate-limit-fail-mode.md), so reads keep working during a Redis outage.

## Example
A buyer has 45 payments. Three calls return 20, 20 and then 5 payments, newest first, with each call passing the previous [`nextCursor`](pagination-cursor.md). Editing one character of the cursor gets `400 invalid_cursor`.

## Known gaps
- The spec does not say whether the page size can be set by the caller or by configuration. The 20 per page comes only from the [acceptance scenario](acceptance-scenario.md).
- The spec does not list any filters other than `orderId`, and does not give the response shape.

## Used by
<!-- used-by:start -->
- [acceptance-scenario](acceptance-scenario.md)
- [pagination-cursor](pagination-cursor.md)
- [rate-limit-fail-mode](rate-limit-fail-mode.md)
- [session-revocation](session-revocation.md)
<!-- used-by:end -->
