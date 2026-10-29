# fin-12. Refunds, chargebacks and disputes

*Fintech pack · Payments · Hard*

## The question

Design refunds and disputes for rent payments. Landlords request refunds (overpayment, move-out), tenants dispute card payments with their bank, and ACH debits come back as unauthorized returns. Often the money was already paid out to the landlord. We see about 400 card disputes a month. Design the workflow, deadlines and ledger effects.

**Then:** A tenant disputes a $2,000 rent card payment as fraud 70 days after paying. The landlord was paid 68 days ago, and the evidence is due in 9 days.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Provider? → assume: Stripe-like; disputes arrive as webhooks with reason, amount and an evidence due date.
- Who bears losses? → assume: the landlord per contract; the platform fronts and recovers from future payouts; the dispute fee policy is in the contract.
- Who can refund, and approvals? → assume: PM or ops request; above a threshold a second person approves.
- Refund destination? → assume: only to the original payment method, never to a different account.
- Partial refunds? → assume: yes; total refunded ≤ captured.
- PMS? → assume: refunds and lost disputes are written back as reversals.

## Design

**A. Refunds (we start them)**
```sql
refunds(id, payment_id, amount_minor, reason, status,   -- requested|approved|submitted|succeeded|failed|canceled
  requested_by, approved_by, provider_refund_id, idempotency_key UNIQUE)
```
- In one transaction: lock the payment row (`FOR UPDATE`), check Σ non-failed refunds + new ≤ captured, check no open dispute, insert.
- Approval (second person above threshold) → ledger: Dr owner payable / Cr refunds payable → submit to the provider with idempotency key = refund id → on success: Dr refunds payable / Cr PSP clearing.
- Card: back to the card. ACH: a credit to the original account.
- Landlord balance too low → negative balance recovered from future payouts, or require funding first (policy).

**B. Card disputes (the bank starts them)**
```sql
disputes(id, payment_id, provider_dispute_id UNIQUE, reason, amount_minor, status,
  evidence_due_by timestamptz, submitted_at, outcome)
dispute_evidence(dispute_id, kind, s3_key, created_at)
```
- Statuses follow the provider (Stripe: `warning_needs_response` for inquiries, `needs_response`, `under_review`, `won`, `lost`).
- On creation the provider usually withdraws the disputed amount plus a fee. Ledger: Dr disputes in progress (amount), Dr dispute fee expense / Cr PSP clearing (amount + fee). Recovery: Dr owner payable / Cr disputes in progress, or a hold of that amount on the landlord's next payout.
- **Won:** the provider returns the amount (whether the fee comes back depends on the provider and region) → reverse. **Lost:** final; the landlord carries it per contract.
- **Evidence** assembled automatically at creation: lease, tenant identity, autopay authorization (text, timestamp, IP), 3DS result, device/IP history, earlier undisputed payments with the same card, PMS ledger showing the tenant in residence. Submitted via the provider API with a buffer before `due_by`; human review above an amount threshold.
- **Deadlines:** always the provider's `due_by`, never a table of reason codes. Alerts at due −5 and −2 days.

**C. ACH unauthorized returns:** no evidence process inside the ACH network; the return is final there. Ledger reversal as for any return, mandate disabled, recovery outside the network (contact the tenant; the landlord treats it as unpaid rent).

## Deep dives

**1. The twist.** 70 days is inside the typical card dispute window (often 120 days for most reason codes; it varies by network and reason). The provider already took $2,000 plus the fee at creation; the ledger shows it and the landlord's payable is debited, so the next payout nets it, or the balance goes negative and is recovered. Evidence: if the payment was 3DS-authenticated, fraud liability generally sits with the issuer; submit the authentication result. Otherwise: the tenant is the leaseholder living in the unit, the same card paid N earlier months without dispute, same device and IP, the autopay authorization. Visa's Compelling Evidence 3.0 specifically counts earlier undisputed transactions with matching device or IP data for card-not-present fraud disputes. The packet is pre-built at creation, so submit within a day or two, not on day 9.

**2. When to charge the landlord.** At creation (hold or debit, release on win) vs at loss. Chosen: hold at creation; outcomes can take months and the landlord may leave. Rejected: waiting for the outcome.

**3. Refund vs dispute race.** A tenant asks for a refund and also disputes, so they could get paid twice. Chosen: no refund on a charge with an open chargeback (Stripe doesn't allow it; accepting the dispute is the refund). An inquiry, before it becomes a chargeback, can still be refunded, which usually closes it. If the dispute arrives after a refund, submit the refund as evidence. Rejected: refunding without checking.

**4. Fight or accept.** Expected value per dispute: win rate by reason × amount − handling cost. Small or weak cases are accepted quickly, which also stops the clock.

## Traps

- Hardcoding evidence deadlines per reason code instead of using the provider's due date.
- Booking a dispute as a refund; it can be reversed on a win and has its own fee.
- Refunding to a different card or account (a money-laundering path).
- Editing the original payment's ledger entries.
- Treating an ACH unauthorized return as something you can contest inside the ACH network.
- Allowing two concurrent refunds whose total exceeds the captured amount.

## Say it (60–90 s)

I separate refunds, which we start, from disputes, which the bank starts. A refund locks the payment row, checks that total refunds stay under the captured amount and that there's no open dispute, needs a second approver above a threshold, goes only to the original payment method, and posts ledger entries that recover the money from the landlord's payable. Disputes arrive as provider webhooks with a due date. The provider withdraws the amount and a fee at creation, so I post that immediately and hold the same amount from the landlord's next payout, releasing it if we win. Evidence is assembled automatically when the dispute opens: lease, authorization, 3DS result, device history, earlier undisputed payments and proof the tenant lives there. Deadlines always come from the provider, never a reason-code table. ACH unauthorized returns have no dispute process in the network, so they're a reversal plus recovery outside it. For the twist, the landlord's payable is already debited; I submit the pre-built packet within a day or two, leading with 3DS if it was used, otherwise prior undisputed payments under Visa's Compelling Evidence rules.

## Follow-ups

**Q:** Can we prevent disputes before they happen?
**A:** Pre-dispute alert services (Verifi and Visa's Rapid Dispute Resolution, Ethoca for Mastercard) let you refund before an inquiry becomes a chargeback. Worth it at volume, because card networks run monitoring programs with dispute-ratio thresholds and fines; the exact thresholds change, so check current program rules.

**Q:** A partial refund was made, then the tenant disputes the full amount.
**A:** Submit the partial refund as evidence; the issuer adjusts the disputed amount or rules on the rest.

**Q:** What goes to the PMS?
**A:** Refunds and lost disputes as reversals; an open dispute as a note or status, not a reversal, since it may still be won.

</details>

## Theory in the notes

- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
