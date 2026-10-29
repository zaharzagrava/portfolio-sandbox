# arch-14. Marketplace payments: PSP, 3DS, webhooks, reconciliation

*Payments · Hard*

## The question

"We run a marketplace for handmade goods: buyers in the US, UK and EU pay by card; one cart can contain items from several sellers; we take a 12% commission and pay sellers out after delivery. ~2M orders a month, peaks on holiday weekends. We use Stripe Connect. Design the flow from 'Pay' to 'sellers paid', including 3DS, how we learn the final status, and how finance knows the money adds up."

**Then:** "A buyer closes the tab during the 3DS challenge while our webhook endpoint is down for 20 minutes. Next morning, finance says yesterday's Stripe payout to our bank is $412.37 less than our ledger expected."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Charge model? → assume: Connect **separate charges and transfers**: we charge the buyer once on the platform, then transfer to each seller's connected account. Destination charges support only one seller per charge. Cross-border availability of this model varies by region; check for our seller countries.
- When are sellers paid? → assume: transfer after delivery confirmation or 14 days after shipping, whichever is first; refunds before that come from the platform balance.
- SCA scope? → assume: PSD2 SCA applies when issuer and acquirer are both in the EEA (the UK has equivalent rules); US cards have no SCA mandate, 3DS there is optional for fraud liability shift. Stripe's automatic 3DS decides per payment.
- Who carries disputes? → assume: the platform (with separate charges it's our balance that's debited); we may reverse the seller's transfer per our terms.
- Numbers → assume: 2M orders/month ≈ 0.8/s avg, ~30/s at holiday peaks; ~1.6 sellers per cart → ~3.2M transfers/month. Webhook volume several events per payment: ~10M/month.
- Reconciliation sources → assume: Stripe balance transactions and payouts via API, our bank statement (BAI2 or CAMT.053) via SFTP daily.

## Design

**1. Pay.** `POST /checkouts/:id/pay` with `Idempotency-Key`. One transaction: `payments(status='initiated')` + one `order_lines` row per seller with amount and fee. Then create a PaymentIntent (amount, currency, `transfer_group = order_id`, `metadata.payment_id`, Stripe idempotency key = our payment ID). Return `client_secret`.

**2. Confirm.** Payment Element calls `stripe.confirmPayment`; Stripe.js runs 3DS if the PI is `requires_action`. Afterwards the browser asks `GET /payments/:id`; the browser never tells us "it succeeded".

**3. Webhooks = source of truth.** Receiver verifies `Stripe-Signature` (HMAC-SHA256 of `timestamp.rawBody`, 5-min tolerance), inserts into `provider_events` (PK = event ID), returns 2xx. A worker re-fetches the PaymentIntent (events can arrive out of order) and applies a guarded transition: `initiated → requires_action → processing → succeeded | failed | canceled`; terminal states never move.

**4. On success,** one transaction: payment `succeeded`, ledger entries, outbox (receipt email, notify sellers).
```
Dr stripe_clearing      100.00   Cr seller:A:payable 52.80   Cr seller:B:payable 35.20
                                 Cr platform:commission 12.00
Dr stripe_fee_expense     3.20   Cr stripe_clearing   3.20        -- from the balance transaction
```

**5. Seller transfers** (after delivery): `POST /v1/transfers {amount, destination, transfer_group, source_transaction: ch_…}` with idempotency key `transfer:{order_line_id}`. `source_transaction` ties it to the charge so it can't fail on our available balance. Ledger: `Dr seller:A:payable / Cr stripe_clearing`.

**6. Sweeper** (every 10 min): payments non-terminal > 15 min → retrieve PI, reconcile; `requires_action` > 24 h → cancel PI, release the cart.

**7. Daily reconciliation.** Ingest raw Stripe balance transactions, payouts and the bank file to S3 (immutable), parse into `recon_records(source, external_id, amount_minor, currency, value_date, payout_id, UNIQUE (source, external_id))`. Level 1: every balance transaction ↔ a ledger entry by Stripe IDs. Level 2: each Stripe payout = Σ its balance transactions = the bank credit with that payout reference. Mismatches → `recon_breaks(type, amount_diff, refs, owner, status, expected_by)`.

## Deep dives

**1. Closed tab + webhook outage (twist, part 1).** The return redirect is lost and our endpoint 5xx'd. Stripe retries failed webhook deliveries with backoff for up to 3 days in live mode, so the events arrive after the outage. Meanwhile the sweeper retrieves stale PIs. If the buyer passed 3DS before closing the tab, the PI is `succeeded` and both paths converge on the same guarded transition; if they abandoned it, it stays `requires_action` and is cancelled after 24 h. Rejected: trusting the client's result (lost with the tab, and forgeable).

**2. The $412.37 shortfall (twist, part 2).** It's a level-2 break: bank credit ≠ expected payout. List the payout's balance transactions (`GET /v1/balance_transactions?payout=po_…`) and anti-join against ledger entries tagged with that payout. The leftover rows are the answer. Usual causes on a marketplace: a dispute withdrawal (amount plus dispute fee), a refund issued from the Stripe dashboard that bypassed our API, a fee higher than estimated (international card, currency conversion), a transfer reversal. Fix the path that bypassed the ledger (handle `charge.dispute.created`, block dashboard refunds or ingest them), post the entries, add a monitor for that event type.

**3. Out-of-order and duplicate events.** `payment_intent.payment_failed` (first card declined) can arrive after `succeeded` (second card on the same PI). Re-fetching the PI and never leaving a terminal state fixes it; the `provider_events` PK drops exact duplicates.

**4. One PI per checkout.** A PI can be re-confirmed with a new card after a decline, so retries don't create new PIs. Our idempotency key maps a double click to one payment. Rejected: a new PI per click (two can succeed).

## Traps

- Marking the order paid on the return URL or a client callback.
- Business logic before returning 2xx to Stripe: slow handlers time out and trigger retries.
- Parsing JSON before verifying the signature: the HMAC is over the raw bytes.
- Destination charges for multi-seller carts: one charge can only go to one connected account.
- Reconciling only daily totals: +$100 missing and −$100 duplicated net to zero. Match by IDs first.
- Fixing a break by editing ledger rows instead of posting an adjusting entry with a reason code.

## Say it (60–90 s)

The backend creates our payment row and per-seller order lines first, then one PaymentIntent with our payment ID in metadata and as Stripe's idempotency key, and the Payment Element confirms it, running 3DS when the issuer asks. The browser never reports the result. Webhooks are the source of truth: I verify the signature on the raw body, store the event by ID, return 2xx, and a worker re-fetches the PaymentIntent and applies a guarded transition, so late or duplicate events can't move a succeeded payment back. Success writes ledger entries splitting the money into each seller's payable and our commission. After delivery, a transfer per seller uses the charge as source transaction and an idempotency key per order line. A sweeper re-fetches payments stuck in non-terminal states, which together with Stripe's three days of webhook retries covers the closed tab and the outage. Every day I reconcile three ways: each Stripe balance transaction against our ledger by ID, and each Stripe payout against the sum of its balance transactions and the bank credit. For the four hundred twelve dollars, I list that payout's balance transactions, anti-join them with our ledger, and the leftover, usually a dispute or a dashboard refund, is the answer.

## Follow-ups

**Q:** A buyer disputes a charge after the seller was paid.
**A:** Stripe debits our platform balance (amount + dispute fee). We record it in the ledger, submit evidence, and per our seller terms create a transfer reversal for that seller's share; if the seller balance is too low, it becomes a receivable on their account.

**Q:** Why store webhook events if you re-fetch the object anyway?
**A:** Dedupe by event ID, audit, replay after a bug, and the event says which object to fetch.

**Q:** Should a reconciliation break block anything?
**A:** An unexplained shortfall above a threshold holds the next seller transfer run until finance clears it; timing breaks (bank credit expected tomorrow) don't.

</details>

## Theory in the notes

- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
