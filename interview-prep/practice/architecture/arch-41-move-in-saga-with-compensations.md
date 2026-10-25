# arch-41. Move-in saga with compensations

*Distributed Systems · Medium*

## The question

"Move-in flow: the tenant signs the lease through an e-signature vendor (async, a webhook when done), we charge the security deposit ($2,000-5,000, card or bank debit), then we activate the tenant: create them in the landlord's PMS, enable autopay, send a welcome. This touches three of our services and two vendors. Design it so a failure at any step leaves a consistent, explainable state."

**Then:** "The deposit was a bank debit, and it comes back returned for insufficient funds 4 days after the tenant was activated. What now?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Is the deposit required before move-in? → assume: yes; activation (keys, portal access) only after the deposit is collected, and the landlord sets whether "collected" means *authorized/submitted* or *settled*.
- Payment methods and their timing? → assume: card authorizes in seconds; US ACH debit settles in 1-2 business days. Returns: insufficient funds usually within 2 banking days of settlement, unauthorized-debit returns on consumer accounts up to 60 days (NACHA rules). Other countries' debit schemes differ.
- Can a signed lease be undone? → assume: no; it's a contract. "Undo" is a business action (cancellation addendum by the landlord), not a delete.
- Who owns the flow? → assume: the leasing service.
- Timeouts? → assume: the tenant has 72 h to sign; 48 h to fix a failed deposit.

## Design

**Orchestration with a durable state machine in the leasing service's Postgres.**
```sql
move_in_sagas(
  id uuid PRIMARY KEY, lease_id uuid, unit_id uuid, state text, version int,
  deposit_payment_id uuid, deadline_at timestamptz, attempts int, last_error text)
-- created → awaiting_signature → signed → deposit_pending → deposit_collected
--   → activating → active
-- side exits: expired | deposit_failed | cancelled | needs_review
```
Each step = guarded state change + outbox command in **one transaction**:
```sql
UPDATE move_in_sagas SET state = 'signed', version = version + 1
WHERE id = $1 AND state = 'awaiting_signature';   -- 0 rows → duplicate or late event, ignore
INSERT INTO outbox (...) VALUES ('CreateDepositPayment', key = 'deposit:' || $1, ...);
```

**Flow**
1. Create saga, reserve the unit (semantic lock: other applicants see "pending"), command `SendForSignature` (idempotency key = saga ID). Deadline 72 h.
2. E-sign webhook → `signed` → command `CreateDepositPayment`.
3. Payments service charges with key `deposit:{saga_id}` and emits `PaymentSucceeded / PaymentFailed / PaymentPending`.
4. `deposit_collected` → `activating`: commands `CreateTenantInPms`, `EnableAutopay`, `SendWelcome`, each idempotent by our IDs, retried with backoff. Persistent failure → `needs_review`, not compensation.
5. A timer job scans `deadline_at < now()` for expiries.

**Compensations (business actions, not deletes)**
| Failure | Compensation |
|---|---|
| Not signed in 72 h | void the envelope, release the unit |
| Card declined | stay `signed`, ask for another method for 48 h; then notify landlord, who may cancel (lease cancellation addendum, release unit) |
| PMS down at activation | retry forward; deposit and lease are valid, nothing to undo |

## Deep dives

**1. Orchestration vs choreography.** Chosen: one orchestrator that holds state, deadlines and the "where is this move-in?" answer. Choreography (each service reacts to the previous one's event) works for two steps; at four steps with deadlines and business rules, the logic spreads across services and nobody can answer why a move-in is stuck. Rejected: 2PC across our services and vendors; vendors don't take part in our transactions, and locks held across a 72-hour signature are absurd.

**2. Put reversible steps before the step you can't undo.** Signing is the pivot: after it, only business compensation exists. For card deposits, place an **authorization hold** before sending for signature and capture after signing; if the tenant never signs, void the hold and no money moved. Hold validity is limited (often ~7 days for online card payments, varying by network and provider), so the capture must happen within that window, otherwise re-authorize. Bank debits can't be held, so they're collected after signing. Rejected: charge first, sign later; refunds cost fees and a disputed refund is worse than a void.

**3. Exactly-once effect per step.** Duplicate webhooks and redelivered commands are normal. Each command carries a key derived from saga ID + step; each transition is guarded by the expected state; vendors get our idempotency keys where they support them. No vendor call happens inside the DB transaction: the outbox relay or a worker makes the call.

## Traps

- 2PC or one "distributed transaction" across services and vendors.
- Treating compensation as delete: a signed lease is a legal fact; a refund is a new ledger entry, not removal of the old one.
- Calling the e-sign vendor or PSP inside the DB transaction.
- No deadlines: sagas sit in `awaiting_signature` forever and units stay reserved.
- Compensating on a transient failure (refunding the deposit because the PMS API was down for an hour).
- Treating a submitted bank debit as paid money.

## Say it (60–90 s)

I'd orchestrate it with a state machine stored in the leasing service's database: one row per move-in, with a state, a version and a deadline. Every step is one transaction that does a guarded state update, where state equals the expected one, and writes an outbox command. A duplicate or late event updates zero rows and is ignored. The flow: reserve the unit and send the lease for signature with a 72-hour deadline; when the signature webhook arrives, move to signed and command a deposit payment with an idempotency key derived from the saga ID; when payments reports success, activate: create the tenant in the PMS, enable autopay, send the welcome, each idempotent and retried forward. Signing can't be undone, so I put reversible steps before it: for cards I place an authorization hold before signing and capture after, so an unsigned lease just voids the hold. Compensations are business actions: an expired signature voids the envelope and releases the unit; a declined deposit gives the tenant 48 hours to use another method, then the landlord decides about cancelling. Failures after the deposit, like the PMS being down, are retried forward and end in needs-review, never in a refund. A timer job handles deadlines, and a metric shows sagas stuck in each state.

## Follow-ups

**Q:** Then: the bank debit is returned 4 days after activation. What now?
**A:** You can't un-activate someone who moved in. The return becomes `PaymentReturned`; the ledger reverses the deposit credit, so the tenant owes it again; the saga goes to `active_deposit_unpaid` and opens a collection case; the landlord is notified. Re-presenting the debit depends on the return reason: for insufficient funds, NACHA allows re-initiating (up to two times within 180 days); for a closed account, ask for a new method. The policy fix: landlords can require settlement (or a card) before activation for large deposits.

**Q:** Why not Temporal or Step Functions?
**A:** Worth it with many long-running workflows. For one flow, a table, an outbox and a timer job are fewer moving parts. Step Functions Standard workflows can run up to a year, so they'd also fit if we were on that path already.

**Q:** How do you find stuck move-ins?
**A:** A metric of sagas per state older than that state's SLA, an alert on any `needs_review`, and an admin view showing the saga's transition history.

</details>

## Theory in the notes

- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
