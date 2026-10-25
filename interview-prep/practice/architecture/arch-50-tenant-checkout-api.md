# arch-50. Tenant checkout API

*API Design · Medium*

## The question

"Design the API our tenant web and mobile apps use to pay rent: see what's owed, pick a saved card or bank account (or add one), pay all or part, and see the result. Card payments can need 3-D Secure; bank debits take 3-5 business days to settle and can be returned after that. Old mobile app versions stay in use for a year."

**Then:** "Product wants roommates to split rent, each paying their own share."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Partial payments? → assume: allowed per landlord setting, with a minimum amount.
- Card data? → assume: never through our API; the PSP's SDK or hosted fields tokenize it, and we receive a payment-method token.
- Fees? → assume: a card convenience fee may apply; whether it's allowed depends on jurisdiction and card-network rules, so it's a per-landlord, per-region config. It's always shown before confirming.
- Currency? → assume: one per lease (e.g. USD or ILS), amounts in minor units.
- Who can pay? → assume: tenants on the lease.
- How do clients learn about async results? → assume: polling `GET` with backoff, plus push or SSE when available (arch-22).

## Design

**Resources**
```
GET  /v1/leases/{leaseId}/balance
     → { currency, totalDue, charges: [{ id, kind, dueDate, amount, remaining }] }
GET  /v1/payment-methods                     → [{ id, type: card|bank_account, brand, last4, status }]
POST /v1/payment-methods { pspToken }        → method (status: active | verification_pending)
POST /v1/payments          Idempotency-Key: <uuid>
     { leaseId, amount: 125000, currency: "USD", paymentMethodId, chargeIds? }
     → 201 { id, status: "requires_confirmation", amount, fee, total, expiresAt }
POST /v1/payments/{id}/confirm   Idempotency-Key: <uuid>
     → 200 { id, status, nextAction? }        // nextAction: { type: "three_ds", clientSecret }
GET  /v1/payments/{id}
GET  /v1/payments?leaseId=&cursor=&limit=    → { data, nextCursor, hasMore }
```
Amounts are integers in minor units plus a currency code. The server computes fee and total; the client only displays them.

**States**
```
requires_confirmation ─confirm─► processing ─► succeeded ─► returned | refunded | disputed
        │                  └──► requires_action (3DS) ─► processing
        └─ expired (quote older than 15 min)        processing ─► failed
```
Card: `processing` lasts seconds. Bank debit: `processing` lasts until settlement, and `succeeded` can still become `returned` later. Each payment exposes an `events` timeline so the UI can say "submitted, usually clears in 3-5 business days".

**Errors.** `application/problem+json` (RFC 9457) with a stable machine `code`:
- `422 amount_exceeds_balance`, `422 below_minimum_amount`
- `409 payment_not_confirmable` (wrong state), `409 quote_expired`
- A declined payment is not an HTTP error: confirm returns `200` with `status: failed` and `failureCode` (`card_declined`, `insufficient_funds`), because the request itself was valid.
Decline reasons shown to tenants are mapped to safe messages; fraud-related declines show a generic message.

**Pagination.** Opaque cursor over `(created_at, id)`, `limit` ≤ 100.

**Versioning and old apps.** `/v1` plus additive changes only. Clients must treat unknown enum values as "pending/other" (documented and tested in the app). Breaking changes go into a dated version the client sends. A config endpoint returns `minSupportedVersion` for forced upgrades in emergencies.

## Deep dives

**1. Two steps: create, then confirm.** The tenant must see the exact fee and total before money moves, and the server must be the one computing them. Create returns a quote valid for 15 minutes; confirm executes it. Rejected: one POST with a client-computed fee; old clients would compute old fee rules, and the client becomes part of pricing.

**2. "Succeeded" is not final for bank debits.** The API exposes `returned` as a state after `succeeded`, and balances show pending payments separately (`pendingAmount`). Clients built assuming success is terminal show wrong balances after a return. Rejected: hiding bank debits in `processing` until the return window closes; for consumer accounts unauthorized-debit returns can come up to 60 days later (US ACH rules), far too long to show "processing".

**3. Concurrent payers and double taps.** Two tabs or two roommates confirm against the same charge. Confirm locks the charge rows (`SELECT ... FOR UPDATE`), recomputes `remaining`, and rejects with `amount_exceeds_balance` (or records a credit, per landlord policy). The `Idempotency-Key` makes a retried confirm return the original result instead of a second payment (mechanics in arch-09).

**4. Year-old clients.** Never repurpose a field, never change a type, add enum values only with the documented fallback. Contract tests run the last N released app versions' API expectations against the server.

## Traps

- Letting the client send the fee or total.
- Floats or formatted strings for money (`"1,250.00"`).
- Treating a submitted bank debit as final, with no `returned` state.
- Offset pagination on payment history.
- Showing raw processor decline reasons to tenants.
- Adding enum values that crash old app versions with exhaustive `switch` statements and no default.

## Say it (60–90 s)

The tenant first reads the balance for a lease: the charges with their remaining amounts, in minor units with a currency. Payment methods are added with a token from the PSP's SDK, so card numbers never reach us. Paying is two steps. Creating a payment returns a quote: amount, fee and total computed by the server, valid for fifteen minutes. Confirming it, with an idempotency key, moves it to processing, or to requires-action with what the client needs for 3-D Secure. Cards finish in seconds. Bank debits stay processing for days, and even after succeeded they can become returned, so the API models that explicitly and the balance shows pending amounts separately. Errors use problem+json with stable codes, like amount-exceeds-balance or quote-expired, and a declined card is a valid request with a failed status and a safe message. On confirm the server locks the charges and recomputes what's left, so two tabs or two roommates can't overpay. History uses cursor pagination. For year-old apps, changes are additive only, clients must handle unknown enum values, and there's a minimum-version switch for emergencies.

## Follow-ups

**Q:** Then: roommates split rent. What changes?
**A:** Add `charge_shares(charge_id, tenant_id, amount)`, set by the landlord or agreed by the tenants. `GET /balance` gains `yourShare` per charge; payments allocate to the charge, and the charge is paid when allocations sum to its amount. Autopay runs per share. If one roommate's payment fails, the charge is partially paid, and late-fee rules decide what happens (arch-11). It's additive: old clients don't see `yourShare` and can still pay up to the remaining amount, which is allowed.

**Q:** How does the client learn the result after 3DS?
**A:** It returns from the 3DS flow and calls `GET /payments/{id}`. Our status comes from the PSP webhook, so the client polls with backoff or listens on SSE until the status leaves `processing`.

**Q:** Why not GraphQL?
**A:** Fine for the read-heavy balance screen. Payments are a small state machine where REST with idempotency keys, plain HTTP caching and per-route rate limits are simpler.

</details>

## Theory in the notes

- [04-api-design/01-rest-design-and-chatty-apis.md](../../04-api-design/01-rest-design-and-chatty-apis.md)
- [04-api-design/02-api-versioning-and-deprecation.md](../../04-api-design/02-api-versioning-and-deprecation.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
