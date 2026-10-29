# arch-48. Debugging: customers report duplicate orders and charges

*Debugging · Medium*

## The question

"Support has 37 tickets this month from meal-kit subscribers who were charged twice for the same week's box, and some received two boxes. Most came from the weekly renewal batch that runs Sunday night; a few from the 'order an extra box' button on the web. Each pair has the same amount, minutes apart, with two different payment provider charge IDs. Find the root cause and fix it permanently."

**Then:** "You find two causes, and one of them is the provider's idempotency key expiring. Explain how that happened."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Do we send idempotency keys to the provider? → assume: yes, but nobody is sure how each path generates them.
- How does the renewal batch run? → assume: a cron enqueues one SQS message per subscription; workers create the order and the charge.
- Is there a DB rule "one renewal per subscription per delivery week"? → assume: unknown; check.
- Can a subscriber legitimately have two orders in a week? → assume: yes: the renewal plus "extra box" orders.
- Telemetry retention? → assume: logs and traces 30 days; provider data through their API and dashboard.
- Refund policy? → assume: refund duplicates immediately and stop the second box if it hasn't shipped.

## Design

**1. Stop the harm first.** Query the provider's charges for the month (export or API), grouped by our metadata `subscription_id + delivery_week + kind`, with count > 1. That gives the real number, usually higher than the ticket count. Cancel duplicate orders not yet picked in the warehouse, refund the extra charges in one reviewed batch, notify customers, and check the ledger recorded both charges and the refunds.

**2. Classify each duplicate by evidence.**
| Our DB | Provider | Meaning |
|---|---|---|
| two order rows | two different keys | we created two orders: a job ran twice or two triggers fired |
| one order row | two different keys | we called the provider twice with new keys: key generated per attempt |
| one order row | same key, two charges | the provider didn't recognize the key: expired, or different parameters |

**3. Likely causes in this setup.**
- SQS visibility timeout (e.g. 30 s) shorter than a slow provider call under batch load → the message reappears and a second worker charges while the first is still waiting.
- The cron running on two instances.
- A retry after a timeout with a new random key.
- Web: a double click, or the app retrying a timed-out request without an idempotency key.

**4. Permanent fix: make the duplicate impossible in the data, not only in one code path.**
```sql
CREATE UNIQUE INDEX one_renewal_per_week
  ON orders (subscription_id, delivery_week)
  WHERE kind = 'renewal' AND status IN ('pending', 'processing', 'paid', 'unknown');
```
- Provider idempotency key derived from our order ID (`ord_123`), stored before the call, reused on every retry.
- Claim → call → record. A timeout sets `unknown`; a resolver looks the charge up at the provider by our order ID before anything is retried.
- Visibility timeout above the worst-case processing time, extended with `ChangeMessageVisibility` during long calls.
- Web "extra box": a client-generated `Idempotency-Key` per click-through (stored with a unique constraint), button disabled while pending.

**5. Detection.** A nightly job runs the provider-side duplicate query and alerts on any hit; a metric of `unknown` orders.

## Deep dives

**1. Why fixing only the trigger you found isn't enough.** There are many paths to "create an order and charge" (renewals, web, admin, retries, future features). Fixing one path leaves the others open. A unique index on the business identity (subscription + week for renewals) is the backstop for all of them. Nuance: "extra box" orders are legitimately several per week, so they get request-level idempotency instead of a business-level unique rule.

**2. Timeouts are "unknown", not "failed".** The provider may have charged and the response got lost. Retrying with a *new* key creates a second charge; retrying with the *same* key is safe only within the provider's idempotency window. Chosen: look the charge up first (by metadata or our ID), then decide.

**3. At-least-once delivery is the default.** SQS standard queues can deliver a message more than once even with a correct visibility timeout. The worker must be safe on redelivery: the claim (`UPDATE orders SET claimed_at = now() WHERE id = $1 AND claimed_at IS NULL`) and the stable provider key make the second delivery a no-op.

## Traps

- Blaming the provider and adding more retries.
- Fixing the one cause you found without a database-level invariant.
- A random UUID idempotency key per attempt: every retry is a new charge.
- Treating a timeout as a failure and charging again.
- Deduplicating in Redis with a TTL: it expires, and it isn't atomic with the order row.
- Engineering the fix before refunding, stopping boxes and counting the affected customers.

## Say it (60–90 s)

First I'd stop the harm: query the payment provider for the month, group charges by our subscription, week and kind metadata, find every duplicate, not just the 37 reported, cancel duplicate boxes that haven't shipped and refund the extra charges. Then I classify each pair by evidence. Two order rows in our database means we created two orders, so a job ran twice. One row and two provider keys means we retried with a new key. Same key and two charges means the provider didn't recognize the key. For the batch, a common cause is an SQS visibility timeout shorter than a slow provider call, so a second worker picks up the same message. The permanent fix is in the data: a unique index on subscription and delivery week for active renewal orders, so no code path can create a second one. The provider idempotency key is derived from our order ID and reused on every retry. Workers claim the order before calling, and a timeout marks it unknown; a resolver looks the charge up before anything retries. The visibility timeout covers the worst-case call. On the web, extra-box orders carry an idempotency key per click. And a nightly job checks the provider for duplicates, so we find the next one before the customer does.

## Follow-ups

**Q:** Then: how did the provider's key expire?
**A:** Providers keep idempotency keys only for a limited time (Stripe documents removing them after at least 24 hours; others differ). A renewal charge on Sunday timed out and was marked failed instead of unknown, but the provider had actually charged it. A retry job on Tuesday re-sent the same key; the key was gone, so the provider created a new charge. Fix: never rely on provider idempotency beyond its window; resolve unknowns by lookup first; our own database is the long-term idempotency record.

**Q:** How do you prove the fix?
**A:** In staging, inject a 40-second provider delay and kill workers mid-call, with redeliveries; assert exactly one charge per subscription and week. Then watch the duplicate detector stay at zero through the next renewal runs.

**Q:** Can refunds duplicate too?
**A:** Same pattern: the refund ID as the provider idempotency key, unique per refund request, and a cap so total refunds ≤ the charged amount.

</details>

## Theory in the notes

- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
