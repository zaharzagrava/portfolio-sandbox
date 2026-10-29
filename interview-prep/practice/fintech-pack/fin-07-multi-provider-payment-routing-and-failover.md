# fin-07. Multi-provider payment routing and failover

*Fintech pack · Payments · Hard*

## The question

We process cards through PSP A and want PSP B as a second provider: route by cost (B is cheaper for some card types) and fail over when A has an outage. Peak 40k card payments a day. Design routing, and how our payment state stays correct across two providers.

**Then:** PSP A times out on a $2,400 charge after 30 seconds. Do you send it to B?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Where are saved cards tokenized? → assume: today only at A. B needs a portable credential: network tokens usable across processors, a PSP-independent vault, or a one-time PCI-compliant card data export.
- Routing inputs? → assume: card brand, BIN country, debit vs credit, amount, provider health, and a cost table.
- Failover scope? → assume: new payment attempts only; no re-sending a payment whose outcome is unknown.
- 3DS? → assume: each PSP runs its own 3DS; a result from A generally can't be reused at B.
- Refunds and disputes? → assume: always on the PSP that processed the charge.
- Success metric? → assume: authorization rate per provider and BIN range, not only cost.

## Design

**1. Port per provider:** `authorize`, `capture`, `refund`, `getByReference(ourAttemptId)`, `parseWebhook`. Our payment state is the truth; provider statuses map into it. Provider-specific extras (3DS options) stay in the adapter.

**2. Attempts table**
```sql
payment_attempts(id uuid, payment_id, provider text, provider_ref text, status text,
  -- initiated | unknown | succeeded | declined | not_sent
  decline_code text, created_at)
CREATE UNIQUE INDEX one_open_attempt ON payment_attempts (payment_id)
  WHERE status IN ('initiated', 'unknown');
CREATE UNIQUE INDEX one_success ON payment_attempts (payment_id) WHERE status = 'succeeded';
```
**3. Router:** a pure function `(card, amount, rules, health) → ordered providers`. Health = circuit breaker per provider (error rate and p95 latency over 1-minute windows) + a manual switch. Rules live in a table so ops can change them without a deploy.

**4. Attempt flow**
- Insert attempt `initiated`, commit. Call the provider with idempotency key = attempt id and our ids in metadata.
- **Success** → attempt `succeeded`, payment `succeeded` (one transaction with ledger + outbox).
- **Issuer decline** → payment `failed`. No cascade: the same issuer decides on B, and repeated attempts count against card-network retry limits.
- **Definitely not processed** (connection refused, DNS failure, provider error that its docs say means nothing was created) → `not_sent` → next provider.
- **Timeout or ambiguous 5xx** → `unknown` → resolve with that provider before anything else.

**5. Webhooks** from both providers go into one inbox; mapped by `provider_ref`.

**6. Refunds, captures and disputes** route to the attempt's provider.

**7. Reconciliation and ledger:** one clearing account per provider, reconciled separately.

## Deep dives

**1. The twist: timeout = unknown, not failed.** A may have charged; sending to B can charge the tenant twice ($4,800 plus two bank lines and a support ticket). Chosen: retry A with the same idempotency key (it returns the original result if processed) or look the attempt up by our reference; tenant sees "processing". If A stays unreachable, the attempt stays `unknown` and a resolver retries; only a confirmed "not found" after A's idempotency window allows B. Exception: an authorization-only flow where a duplicate auth can be voided cheaply; even then, auto-void A on resolution. Rejected: blind failover on timeout.

**2. Token portability.** A's tokens are useless at B. Chosen: new cards captured into a PSP-independent vault or as network tokens that work across processors; routing only considers providers the card has a credential for. Existing cards: a one-time PCI-compliant migration from A, if A supports export. Rejected: storing PANs ourselves (full PCI DSS scope).

**3. Cost vs approval rate.** B being cheaper by 0.2% is wiped out if its approval rate is 1% lower. Chosen: route a small % to B first, compare approval rates per BIN range, then shift. Rejected: static cost-only routing.

**4. Late success from the other provider.** If an `unknown` attempt on A resolves to success after B also succeeded, the unique index refuses a second `succeeded`; the attempt goes to `duplicate`, an automatic refund or void is issued, and an alert fires.

## Traps

- Failing over on timeouts; an unknown outcome is not a failure.
- Cascading issuer declines to the second provider; it fails again, costs fees, and counts against network retry limits.
- Assuming saved-card tokens work at any provider.
- `if (provider === 'A')` spread through the payment code.
- Abstracting down to the features both providers share and losing 3DS or other provider-specific controls.
- Sending refunds or dispute evidence to the wrong provider.

## Say it (60–90 s)

I'd keep our own payment state as the truth and model each try as an attempt row, with a partial unique index allowing only one open attempt and one success per payment. Each provider sits behind one port: authorize, refund, look up by our reference, parse webhooks. A pure router function orders providers using card attributes, a cost table and a circuit breaker per provider, and I'd validate cost routing against approval rates before shifting traffic. An attempt has four outcomes: success, issuer decline, definitely not sent, and unknown. Only definitely-not-sent fails over. Issuer declines don't cascade, because the same issuer decides and networks limit retries. On the twist: a 30-second timeout is unknown, so no, I don't send it to B. I retry A with the same idempotency key or look the attempt up by our reference, and show the tenant processing until it resolves. Two other points: tokens aren't portable, so B needs a vault or network tokens; and refunds and disputes always go to the provider that charged.

## Follow-ups

**Q:** How do you detect A's outage quickly?
**A:** A circuit breaker on error rate and latency per minute, alerts tagged by provider, and a manual switch for ops. Provider status pages lag.

**Q:** 3DS completed on A, then A fails.
**A:** The authentication generally belongs to A's flow; run 3DS again on B. A standalone 3DS server whose results can be passed to either acquirer avoids that, at the cost of another vendor.

**Q:** What changes in reconciliation?
**A:** A second settlement stream: one clearing account and one recon job per provider.

</details>

## Theory in the notes

- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [10-system-design/11-application-architecture.md](../../10-system-design/11-application-architecture.md)
