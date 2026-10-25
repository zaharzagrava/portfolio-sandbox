# arch-48. Tenants report duplicate charges

*Debugging · Medium*

## The question

"Support has 37 tickets this month from tenants charged twice for the same rent. Most were autopay on the 1st; a few were manual web payments. Each pair is the same amount, minutes apart, with two different PSP charge IDs. Find the root cause and fix it permanently."

**Then:** "You find two causes, and one of them is the PSP's idempotency key expiring. Explain how that happened."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Do we send idempotency keys to the PSP? → assume: yes, but nobody is sure how they're generated in each path.
- How does autopay run? → assume: a cron enqueues SQS messages; workers create the PSP charge.
- Is there a DB rule "one rent payment per lease per period"? → assume: unknown; check.
- Telemetry retention? → assume: logs and traces 30 days, PSP data available through their API and dashboard.
- Refund policy? → assume: refund duplicates immediately; it's tenants' rent money.

## Design

**1. Stop the harm first.** Query the PSP's charges (export or API) for the month, grouped by our metadata `lease_id + period`, with count > 1. That gives the real number, which is usually higher than the ticket count. Refund the extra charges (one reviewed batch), notify tenants, and check the ledger recorded both and the refunds.

**2. Classify each duplicate by evidence.**
| Our DB | PSP | Meaning |
|---|---|---|
| two payment rows | two different keys | we created two payments: a job ran twice or two triggers fired |
| one payment row | two different keys | we called the PSP twice with new keys: key generated per attempt |
| one payment row | same key, two charges | the PSP didn't recognize the key: expired, or different parameters |

**3. Likely causes in this setup.**
- SQS visibility timeout (e.g. 30 s) shorter than a slow PSP call on rent day → the message reappears and a second worker charges while the first is still waiting.
- Cron running on two instances.
- Retry after timeout with a new random key.
- Web: double click, or the app retrying a timed-out request without an idempotency key.

**4. Permanent fix: make the duplicate impossible in the data, not only in one code path.**
```sql
CREATE UNIQUE INDEX one_active_rent_payment
  ON payments (lease_id, charge_period)
  WHERE kind = 'rent' AND status IN ('pending', 'processing', 'succeeded', 'unknown');
```
- PSP idempotency key derived from our payment ID (`pay_123`), stored before the call, reused on every retry.
- Claim → call → record. A timeout sets `unknown`; a resolver looks the charge up at the PSP by our payment ID before anything is retried.
- Visibility timeout above the worst-case processing time, extended with `ChangeMessageVisibility` during long calls.
- Web: client-generated `Idempotency-Key` per checkout (arch-09), button disabled while pending.

**5. Detection.** A nightly job runs the PSP-side duplicate query and alerts on any hit; a metric of `unknown` payments.

## Deep dives

**1. Why fixing only the found trigger isn't enough.** There are many paths to "create a payment" (autopay, web, admin, retries, future features). Each fix in one path leaves the others open. A unique index on the business identity (lease + period) is the backstop for all of them. Nuance: partial payments and roommates are legitimate multiple payments, so if the product allows them, the invariant becomes "allocated ≤ amount due", checked in a transaction that locks the charge row (`SELECT ... FOR UPDATE`).

**2. Timeouts are "unknown", not "failed".** The PSP may have charged and the response got lost. Retrying with a *new* key creates a second charge; retrying with the *same* key is safe only within the PSP's idempotency window. Chosen: look the charge up first (by metadata or by our ID), then decide.

**3. At-least-once delivery is the default.** SQS standard queues can deliver a message more than once even with a correct visibility timeout. The worker must be safe on redelivery: the claim (`UPDATE payments SET claimed_at = now() WHERE id = $1 AND claimed_at IS NULL`) and the stable PSP key make the second delivery a no-op.

## Traps

- Blaming the PSP and adding more retries.
- Fixing the one cause you found without a database-level invariant.
- A random UUID idempotency key per attempt: every retry is a new charge.
- Treating a timeout as a failure and charging again.
- Deduplicating in Redis with a TTL: it expires, and it isn't atomic with the payment row.
- Engineering the fix before refunding and counting the affected tenants.

## Say it (60–90 s)

First I'd stop the harm: query the PSP for the month, group charges by our lease and period metadata, find every duplicate, not just the 37 reported, and refund them. Then I classify each pair by evidence. Two payment rows in our database means we created two payments, so a job ran twice. One row and two PSP keys means we retried with a new key. Same key and two charges means the PSP didn't recognize the key. For autopay, a common cause is the SQS visibility timeout being shorter than a slow PSP call on rent day, so a second worker picks up the same message. The permanent fix is in the data: a unique index on lease and period for active rent payments, so no code path can create a second one. The PSP idempotency key is derived from our payment ID and reused on every retry. Workers claim the payment before calling, and a timeout marks it unknown; a resolver looks the charge up at the PSP before anything retries. The visibility timeout covers the worst-case call. On the web, the client sends an idempotency key per checkout. And a nightly job checks the PSP for duplicates, so we find the next one before the tenant does.

## Follow-ups

**Q:** Then: how did the PSP key expire?
**A:** PSPs keep idempotency keys only for a limited time (Stripe documents removing them after at least 24 hours; other PSPs differ). An autopay charge on the 1st timed out and was marked failed instead of unknown, but the PSP had actually charged it. A retry job on the 3rd re-sent the same key; the key was gone, so the PSP created a new charge. Fix: never rely on PSP idempotency beyond its window; resolve unknowns by lookup first; our own database is the long-term idempotency record.

**Q:** How do you prove the fix?
**A:** In staging, inject a 40-second PSP delay and kill workers mid-call, with redeliveries; assert exactly one charge per lease and period. Then watch the duplicate detector stay at zero through the next rent day.

**Q:** Can refunds duplicate too?
**A:** Same pattern: refund ID as the PSP idempotency key, unique per refund request, and a cap so total refunds ≤ the payment amount.

</details>

## Theory in the notes

- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
