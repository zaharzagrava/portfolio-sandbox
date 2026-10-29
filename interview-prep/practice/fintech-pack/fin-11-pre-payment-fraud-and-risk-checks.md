# fin-11. Pre-payment fraud and risk checks

*Fintech pack · Security · Medium*

## The question

Before we submit a tenant payment (card or ACH), we want risk checks: velocity, new device, one bank account used by many tenants, amount far above the lease rent, and a vendor ML score. The payment API has a p99 budget of 800 ms; the vendor score takes 150-600 ms. Our losses are mostly ACH unauthorized returns that arrive after the landlord was paid, and stolen cards. Design where the checks run and how decisions are made.

**Then:** After launch, 3% of legitimate payments on the 1st are blocked and support is flooded. What do you do?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Card fraud tooling? → assume: the PSP has its own (e.g. Stripe Radar); our checks matter most for ACH, where nothing scores the debit for us.
- Possible actions? → assume: allow, step up (3DS for cards; instant account verification for ACH), hold payout, manual review, block.
- Targets? → assume: keep unauthorized ACH returns well below Nacha's 0.5% threshold; false-positive blocks below 0.3% of payments.
- Latency budget for risk inside 800 ms? → assume: ~200 ms.
- Labels? → assume: chargebacks, unauthorized returns (R05, R07, R10, R11) and review outcomes, arriving days to months later.
- Data available? → assume: device id, IP, account age, payment method fingerprint, lease rent.

## Design

**Two stages**

1. **Sync, in the request (≤ 200 ms):**
   - Rules on precomputed features: velocity per tenant, payment method, bank account fingerprint and IP (Redis counters); amount vs lease rent (e.g. > 1.5×); new payment method + high amount; bank fingerprint linked to > 3 tenants; blocklists.
   - Vendor score called in parallel with a 200 ms timeout; used if it answers in time.
   - Output: `allow | step_up | review | block` + reasons.
2. **Async, after submission and before money leaves:** full vendor score, graph checks (shared devices, bank accounts, emails), and payout eligibility. For ACH this is natural: settlement takes 1-2 days and payouts wait for `cleared` anyway, so a risky payment can be held without blocking the tenant.

**Storage**
```sql
risk_decisions(id, payment_id, stage, decision, reasons text[], score numeric,
  rule_versions jsonb, features jsonb, latency_ms int, created_at)
risk_rules(id, name, version, expression jsonb, action, mode,   -- shadow | active
  created_by, activated_at)
risk_labels(payment_id, label, source, labeled_at)  -- chargeback | unauthorized_return | review_fraud | review_ok
```
**Velocity counters** in Redis: per-minute buckets with `INCR` + `EXPIRE`, summed over the window. Losing Redis resets counters; rules degrade, nothing breaks. Postgres stays the source of truth.

**Step-up over block:** card → force 3DS (fraud liability generally shifts to the issuer); ACH → require instant account verification via open banking, or offer card. Block only on high-confidence signals (blocklist, confirmed fraud ring).

**Fail mode:** vendor down → rules only. High-risk segment (new account + new method + high amount) fails closed to `review`; everything else fails open.

**Rule lifecycle:** every new rule starts in `shadow` (log what it would do) for ~2 weeks, gets a backtest on labeled history, then `active`. Dashboards per rule: hit rate, confirmed fraud, false positives.

## Deep dives

**1. Sync vs async split.** Only checks that must stop money before submission run in the request. Chosen: cheap rules sync, heavy scoring async before payout. Rejected: everything sync (vendor latency and outages land on rent day); everything async (a stolen-card charge already captured still costs fees and a dispute).

**2. False positives on the 1st (the twist).** (1) Use `risk_decisions.reasons` to find which rule fires; typically velocity thresholds tuned on mid-month traffic. (2) Switch that rule to `shadow` or change its action from `block` to `step_up`. Rules are data, so no deploy. (3) Release or contact blocked tenants. (4) Fix: seasonal thresholds (per day of month), allowlist tenants with long clean history, and backtest every rule against the previous rent day before activation.

**3. Feedback is slow.** Unauthorized returns arrive up to 60 days later, chargebacks later still, so precision is unknown for weeks. Chosen: store features at decision time, join labels later, review rules monthly. Rejected: tuning on review outcomes only (reviewers see only flagged payments).

**4. Payout-side fraud.** Many losses come from changes on the landlord side (new payout account); those checks belong to the payout flow, not here.

## Traps

- Blocking the payment when the vendor times out.
- Relying only on the PSP's card fraud tool; ACH debits get no scoring from anyone else.
- Hard blocks with no step-up path.
- Rules in code, so tuning needs a deploy.
- Not storing features and reasons; you can't explain a decision or retrain.
- Measuring fraud caught but not legitimate payments blocked.

## Say it (60–90 s)

I split risk into a synchronous stage and an asynchronous one. In the request I run cheap rules on precomputed features: velocity counters in Redis per tenant, card, bank account and IP, amount against the lease rent, a new payment method with a high amount, and a bank account shared by several tenants. The vendor score runs in parallel with a 200-millisecond timeout and is used only if it answers in time. The result is allow, step up, review or block, and step up is preferred: 3DS for cards, instant account verification for ACH. After submission an async stage runs the full score and graph checks before payout, which suits ACH because payouts wait for the return window anyway. Every decision is stored with reasons, rule versions and features, and labels from chargebacks, returns and reviews join later. Rules are data with a shadow mode, so for the twist I find the firing rule from the stored reasons, switch it to shadow or to step-up without a deploy, contact blocked tenants, and from then on backtest each rule on the previous rent day before activation.

## Follow-ups

**Q:** How do you pick thresholds?
**A:** Backtest on labeled history, pick a target precision, run in shadow mode, then activate. Revisit monthly.

**Q:** Someone tests stolen cards on our pay endpoint.
**A:** Rate limits per IP and account, a challenge after repeated declines, the PSP's tools, and an alert on decline-rate spikes.

**Q:** What do you tell a blocked tenant?
**A:** A generic message with an alternative ("verify your bank account" or "use another method"). Never the rule.

</details>

## Theory in the notes

- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [07-observability-reliability/02-logs-metrics-traces.md](../../07-observability-reliability/02-logs-metrics-traces.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
