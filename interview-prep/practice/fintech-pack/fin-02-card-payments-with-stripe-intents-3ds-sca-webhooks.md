# fin-02. Card payments with Stripe: intents, 3DS/SCA, webhooks

*Fintech pack · Payments · Medium*

## The question

Tenants can pay rent by card through Stripe: one-off in the web app and as saved-card autopay. Most tenants are in the US; some pay with UK or EU-issued cards where SCA can apply. About 30k card payments a month, most on the 1st. Design the flow from the "Pay" click to "rent marked paid", including 3DS and how our system learns the final status.

**Then:** The tenant closes the tab during the 3DS challenge, and our webhook endpoint was down for 20 minutes. How does the payment end up in the right state?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Card entry? → assume: Stripe Payment Element; card data never touches our servers.
- Capture? → assume: immediate capture; nothing to ship.
- Autopay? → assume: card saved with `setup_future_usage: 'off_session'` on the first payment (or a SetupIntent), later charges off-session.
- SCA scope? → assume: PSD2 SCA applies when both the issuer and the acquirer are in the EEA (UK has its own equivalent rules); for other combinations it is best effort or not required. US has no SCA mandate; 3DS there is optional for fraud liability shift. Stripe's `automatic` 3DS handles the decision.
- Who sees the status? → assume: tenant UI, landlord dashboard, PMS write-back.
- Partial payments? → assume: allowed, amount ≤ open balance.

## Design

**Flow**
1. `POST /payments {chargeId, amount}` with `Idempotency-Key`. Backend inserts `payments` (status `initiated`), then creates a PaymentIntent: amount, currency, customer, `metadata.payment_id`, Stripe idempotency key = our payment id. Returns `client_secret`.
2. Frontend calls `stripe.confirmPayment`. If the PI is `requires_action`, Stripe.js shows the 3DS challenge. After it, the frontend asks our backend `GET /payments/:id`; it never tells the backend "it succeeded".
3. **Webhooks are the source of truth.** Receiver verifies `Stripe-Signature` (HMAC-SHA256 over the raw body with timestamp tolerance), inserts the event by event id (unique), returns 2xx. A worker retrieves the current PaymentIntent from the API (events can arrive out of order) and applies a guarded transition.
4. **Our states** mapped from PI status: `initiated` → `requires_action` → `processing` → `succeeded` | `failed` | `canceled`. Terminal states never move back.
5. **On success**, one transaction: status, ledger (Dr Stripe clearing / Cr tenant receivable; fee from the balance transaction), outbox: receipt, PMS write-back.
6. **Autopay:** server creates the PI with saved `payment_method`, `off_session: true, confirm: true`. Error `authentication_required` → status `requires_action`, email the tenant a link to finish on-session.
7. **Sweeper** every 10 min: our payments in non-terminal states older than 15 min → retrieve PI, reconcile. `requires_action` older than 24 h → cancel the PI, tenant can start again.
8. Daily reconciliation against Stripe balance transactions (separate job).

```sql
payments(id, tenant_id, charge_id, amount_minor, currency, status, provider, provider_ref UNIQUE,
         idempotency_key, created_at, updated_at)
provider_events(provider, event_id, type, payload jsonb, received_at, processed_at,
         PRIMARY KEY (provider, event_id))
```

## Deep dives

**1. Closed tab + webhook outage (the twist).** The redirect back is lost. Stripe retries undelivered webhooks with backoff for up to 3 days in live mode, so the events arrive after our 20-minute outage. Meanwhile the sweeper retrieves stale PIs. If the tenant passed 3DS before closing the tab, the PI is `succeeded` and both paths converge on it. If they abandoned the challenge, it stays `requires_action` and the sweeper cancels it later. Rejected: trusting the client-side result (lost when the tab closes, and the client can lie).

**2. 3DS policy.** For in-scope EEA/UK transactions the issuer can demand SCA; exemptions exist (low value, transaction risk analysis, merchant-initiated). Off-session autopay charges are merchant-initiated and out of SCA scope if the first payment was authenticated with the mandate, but the issuer can still decline with `authentication_required`, so the on-session recovery path is required. Successful 3DS generally shifts liability for fraud chargebacks to the issuer; it does not cover non-fraud disputes. Rejected: forcing 3DS on every US card (conversion drops for little gain); never using it (in-scope EU payments get declined).

**3. No double charge.** One PaymentIntent per payment; the PI can be confirmed again after a decline, so retries don't create new PIs. Our API's idempotency key maps a double click to one payment row. Rejected: a new PI per click.

**4. Out-of-order events.** `payment_failed` (first card declined) can arrive after `succeeded` (second card). Re-fetching the PI and refusing to leave a terminal state fixes it.

## Traps

- Marking rent paid on the return URL or a client callback.
- Doing business logic before returning 2xx to Stripe; slow handlers time out and cause retry storms.
- Parsing JSON before verifying the signature; the HMAC is over the raw bytes.
- Assuming SCA applies to US cards, or assuming off-session EU charges never need authentication.
- Treating `processing` as failure; some methods stay processing for a while.
- Creating a new PaymentIntent on every retry; two can succeed.

## Say it (60–90 s)

The backend creates our payment row first, then a PaymentIntent with our payment id in metadata and as Stripe's idempotency key, and gives the client secret to the Payment Element. Stripe.js runs 3DS when the PI needs action. The browser never tells us the result; after confirm it asks our API for the payment status. The source of truth is Stripe webhooks: I verify the signature on the raw body, store the event by id, return 2xx, and a worker re-fetches the PaymentIntent and applies a guarded transition, so late or duplicate events can't move a succeeded payment back. Success writes the ledger entries and outbox rows for the receipt and PMS write-back in one transaction. For autopay I charge the saved card off-session; if the issuer still asks for authentication, the tenant gets a link to finish on-session. A sweeper re-fetches any payment stuck in a non-terminal state, which covers a closed tab or a webhook outage, and Stripe also retries webhooks for days. SCA is an EEA and UK rule, so for US cards I'd use 3DS only on risky payments.

## Follow-ups

**Q:** An autopay card is declined.
**A:** Map the decline code. Insufficient funds: retry later on the autopay schedule, within card-network retry limits. Lost, stolen or "do not honor" style codes: stop and ask the tenant for a new card.

**Q:** Why store webhook events if you re-fetch the object anyway?
**A:** Dedupe by event id, audit, replay after a bug, and the event tells the worker which object to fetch.

**Q:** How does the tenant see "paid" within seconds?
**A:** After confirm, the frontend calls our API; the backend retrieves the PI server-side and syncs. That's safe because the data comes from Stripe, not the browser.

</details>

## Theory in the notes

- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
