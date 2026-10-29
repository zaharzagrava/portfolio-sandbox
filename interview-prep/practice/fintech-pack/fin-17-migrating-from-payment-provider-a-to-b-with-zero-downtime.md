# fin-17. Migrating from payment provider A to B with zero downtime

*Fintech pack · Payments · Hard*

## The question

We process ~400k card and bank-debit rent payments a month through PSP A and are moving to PSP B for lower fees. 150k tenants have saved cards on autopay. A's contract ends in 6 months. Migrate with zero downtime and, if possible, without tenants re-entering card details.

**Then:** Two weeks after moving 50% of traffic, B's card approval rate is 4 points lower than A's for comparable tenants. What do you do?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Will A export card data to B, and can B import it? → assume: yes, a PSP-to-PSP export of card numbers over a PCI-compliant channel, typically taking weeks; we receive only a mapping of A references to B tokens.
- Can B also import the card schemes' network transaction ids for stored credentials? → assume: ask; without them, merchant-initiated autopay charges on B may lose the link to the original customer-initiated transaction.
- Bank-debit mandates: in our name or in A's name? → assume: depends on scheme and country. Mandates in our name keep working; mandates held under A's identity may need re-authorization by tenants.
- Can A stay open after cutover for refunds, disputes and late returns? → assume: yes, 6-12 months. Card dispute windows are commonly up to 120 days from the transaction, and some cases run longer.
- Does provider-specific code leak into the domain today? → assume: partly (Stripe-style statuses in our tables).
- Settlement timing on B? → assume: different; it changes when landlord payouts can be funded.

## Design

1. **Port first.** `PaymentProvider` interface: `createPaymentMethod`, `charge`, `refund`, `parseWebhook`, `getPayment`. Canonical statuses in the domain; provider statuses only inside adapters.
2. **Every payment belongs forever to the provider that created it:** status, refunds, disputes and returns go to that provider.
```sql
payments (id, ..., provider text NOT NULL, provider_ref text)
provider_payment_methods (
  payment_method_id uuid, provider text, provider_ref text,
  status text, imported_at timestamptz,
  PRIMARY KEY (payment_method_id, provider));
```
3. **Token migration.** A exports to B; we load B's mapping file into `provider_payment_methods`; verify counts, brand, last 4 and expiry match. From switch date S, new cards are collected with B's hosted fields only; a delta export covers cards added on A between the bulk export and S.
4. **Routing.** Feature flag by cohort: `hash(tenant_id) % 100 < rolloutPct`, only for tenants whose payment method has a B token. Ramp 1% → 5% → 25% → 50% → 100% over weeks; autopay cohorts move after one-off payments look clean.
5. **Webhooks and reconciliation** for both providers in parallel, normalized to the same canonical events; separate clearing accounts per provider in the ledger.
6. **Rollback** = lower the flag. It works only because A tokens stay valid while A's account is open.
7. **Bank debits.** Mandates in our name: B uses the same mandate references. Mandates held by A: in-app re-authorization well before rent day.
8. **Per-provider dashboards:** approval rate by BIN/issuer, 3DS challenge rate, latency, webhook lag, fees, retries.
9. **Tail.** A handles its own refunds, disputes and returns; settlement reconciliation on A continues until the last payout; then close A.

## Deep dives

**1. Card tokens are provider-specific.**
Problem: 150k saved cards; tokens don't move between PSPs.
Approach: PSP-to-PSP export; we never see a card number, so our PCI scope doesn't change. Keep a dual mapping until A closes. Also ask B to import network transaction ids and to enable its account updater, so recurring charges keep the stored-credential context and get updated card details.
Rejected: asking 150k tenants to re-enter cards. Some won't, and autopay failures land on rent day.

**2. In-flight money and cutover.**
Problem: bank debits stay pending for days and can be returned later; refunds arrive weeks later.
Approach: provider is fixed per payment. A retry of a failed A payment stays on A until it's terminal; only new payment attempts route by flag.
Rejected: big-bang cutover at midnight. In-flight debits, returns and refunds have nowhere to go, and there's no cohort to roll back.

**3. The approval-rate drop (twist).**
Problem: −4 points on B. A hash-based cohort split makes the comparison fair, so it's B, not the tenants.
Approach: break it down by issuer/BIN, card type, CIT vs MIT. Usual causes: merchant-initiated charges sent without the original network transaction id or stored-credential flags; account updater off on B; different merchant category code or descriptor; B's risk engine declining; in the EU, SCA exemptions for MIT depend on that original-transaction link. Roll the affected segment back to A by flag (A tokens still valid), fix with B, re-ramp.
Rejected: "retry declines on A automatically". A second attempt on another PSP for the same payment risks a double charge if the first is actually pending, and repeated retries can draw scheme penalties.

## Traps

- **Big-bang switch** with no cohort rollback.
- **Assuming tokens are portable** between PSPs.
- **Closing A at cutover**: refunds, disputes and bank returns for A payments keep arriving for months.
- **Provider statuses in domain tables** (`stripe_status`): migration then touches every module.
- **Ignoring stored-credential data, account updater and 3DS exemptions**: the approval drop shows up weeks later on autopay.
- **Moving a retry of an A payment to B**: two providers, one intent, possible double charge.

## Say it (60–90 s)

First I put a provider port in front of both PSPs and make sure the domain only knows canonical statuses, and every payment records which provider owns it, forever, because refunds, disputes and bank returns must go back to that provider. Card tokens don't move between PSPs, so A exports card data directly to B and we receive a mapping file from A's references to B's tokens; we never see card numbers. I also ask B to import network transaction ids and enable account updater, so autopay keeps working. From a switch date, new cards are collected on B, with a delta export for the gap. Then routing is a feature flag by hashed tenant cohort, only for tenants who have a B token, ramping from one percent to a hundred over weeks while I watch approval rates by issuer, 3DS challenges, latency and webhook lag. Rollback is lowering the flag, which works because A stays open, and it stays open for six to twelve months for refunds and disputes. If B approves four points less, I break it down by issuer and by customer- versus merchant-initiated charges, roll the affected segment back, fix the cause with B, and ramp again.

## Follow-ups

**Q:** How long do you run both?
**A:** Until A's refund and dispute windows have passed for the last A payment and A's settlements reconcile to zero; plan 6-12 months and make sure the contract allows it.

**Q:** How do you reconcile during the dual run?
**A:** Per-provider settlement reports against our payments, with a separate clearing account per provider, so a mismatch points at one provider.

**Q:** How do landlords notice?
**A:** Payout timing may shift with B's settlement schedule. The payout scheduler uses per-provider settlement dates, and landlords are told in advance.

</details>

## Theory in the notes

- [10-system-design/11-application-architecture.md](../../10-system-design/11-application-architecture.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md](../../08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
