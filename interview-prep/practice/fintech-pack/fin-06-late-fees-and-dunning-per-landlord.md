# fin-06. Late fees and dunning per landlord

*Fintech pack · Payments · Easy*

## The question

Landlords want late fees, e.g. "after a 5-day grace period charge $50, then $10 per day up to $200 total", and reminders by email/SMS at T−3, T+1 and T+5, with escalation to the property manager at T+10. 4,000 landlords, each with their own rules. Design it.

**Then:** A tenant's ACH payment was initiated on the 4th but settles on the 7th, and the fee job ran on the 6th. Another tenant paid at 23:50 their local time on the last grace day.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Who owns late fees: us or the PMS? → assume: we assess and write them back to the PMS; the PMS's own late-fee automation is turned off for those properties, otherwise tenants get charged twice.
- Legal limits? → assume: they vary by US state and city (caps, required grace periods) and by country; rules are validated against a jurisdiction table maintained with legal.
- What counts as paid on time? → assume: a payment initiated by the deadline, even if still pending.
- Partial payments? → assume: a fee applies only if the unpaid balance exceeds a landlord threshold.
- Deadline time zone? → assume: the property's.
- SMS consent? → assume: opt-in required (TCPA in the US); email is the default channel.

## Design

**1. Rules as versioned data**
```ts
type LateFeeRule = {
  graceDays: number;              // fee starts the day after due + graceDays
  initial: Money;                 // $50
  daily?: Money;                  // $10
  cap?: Money;                    // $200 total per period
  minUnpaid: Money;               // ignore small leftovers
};
```
`late_fee_rules(id, landlord_id, property_id NULL, version, rule jsonb, effective_from date)`; property rule beats landlord rule. Saving a rule runs the jurisdiction check.

**2. Assessment job**, once a day per time zone at 00:30 local:
- For each lease with an unpaid rent charge where `localToday > due_date + graceDays`:
- `unpaid = rent − (succeeded + pending payments initiated before the deadline)`.
- If `unpaid > minUnpaid`: compute today's fee with a pure function `assess(rule, daysLate, alreadyCharged)`, respecting the cap.
- Insert with a unique key; the ledger entry and PMS write-back go through the outbox.
```sql
late_fees(id, lease_id, period date, kind, day date, amount_minor, rule_version_id, status,
  UNIQUE (lease_id, period, kind, day))   -- reruns can't double-charge
```

**3. Dunning:** `dunning_steps(lease_id, period, step, channel, scheduled_at, status)` planned from the landlord's schedule. The sender re-checks the balance at send time and skips if paid or a payment is pending. A payment event also cancels future steps immediately.

**4. Escalation (T+10):** a task in the PM's back-office queue. No automatic legal action.

**5. Waivers:** a PM waives a fee → reversing ledger entry + PMS write-back + audit record.

## Deep dives

**1. Pending payments (the twist, part 1).** The tenant initiated on the 4th, before the deadline. Chosen: initiated-before-deadline counts as on time, so the job on the 6th assesses nothing. If that payment later returns, the fee is assessed then, dated per the landlord's policy. Rejected: only settled payments count; the tenant gets a fee for an ACH delay they can't control, and in some jurisdictions that fee may not be enforceable.

**2. 23:50 local on the last grace day (the twist, part 2).** Deadline = end of that local date in the property's zone; compare `initiated_at` converted to that zone. 23:50 is on time. Rejected: UTC dates, which make an evening payment in New York "late".

**3. Idempotent assessment.** Unique `(lease, period, kind, day)` means a rerun or two overlapping jobs can't double-charge. Rejected: a "job ran today" flag.

**4. Rule changes mid-month.** The rule version in force on the due date applies to the whole period; a new version starts next period. Rejected: evaluating past periods with the current rule.

## Traps

- Rules hardcoded in code, or one global rule.
- Ignoring local late-fee laws; caps and grace periods differ by jurisdiction.
- Both our system and the PMS charging late fees.
- Comparing dates in UTC.
- Sending reminders from a list built in the morning without re-checking the balance at send time.
- Treating a pending ACH payment as unpaid.

## Say it (60–90 s)

Late-fee rules are versioned data per landlord, with optional property overrides, and they're validated against a jurisdiction table because caps and grace periods differ by state and country. A daily job per time zone finds leases past due date plus grace in the property's local date, computes the unpaid amount counting payments that were initiated before the deadline, and runs a pure function that returns today's fee given the rule, days late and what's already been charged, so the cap holds. Each fee row has a unique key on lease, period, kind and day, so reruns can't double-charge. Ledger entries and PMS write-backs go through the outbox, and the PMS's own late-fee automation must be off. Reminders are planned steps that re-check the balance when they're sent, and any payment event cancels the remaining steps. For the twist: the tenant who initiated on the 4th is on time, and if that payment returns we assess then. The 23:50 payment is on time because the deadline is the end of the local day in the property's time zone.

## Follow-ups

**Q:** A tenant disputes a late fee.
**A:** The PM waives it in the back office: reversing ledger entry, PMS write-back, audit record with who and why.

**Q:** How do you test 4,000 different rules?
**A:** The assessment is a pure function, so table-driven tests: caps, partial payments, pending then returned, rule version boundaries.

**Q:** Should reminders stop when a payment is only initiated?
**A:** Yes. A pending payment suppresses reminders; if it returns, dunning resumes with a "payment returned" message.

</details>

## Theory in the notes

- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [10-system-design/11-application-architecture.md](../../10-system-design/11-application-architecture.md)
