# arch-06. Daily reconciliation: provider and bank vs ledger

*Data · Medium*

## The question

Every day we get Stripe balance transactions and payouts (API), an ACH provider settlement and returns file (SFTP), and our bank statement (CAMT.053 or BAI2). Our ledger says what should have happened. Design a daily reconciliation that finds mismatches and makes them actionable for finance. ~20k transactions a day, ~200k on the 1st-3rd.

**Then:** Finance reports that the bank received $412.37 less than the ledger expected for yesterday's Stripe payout. How does your system find out why?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Sources and delivery? → assume: Stripe via API, ACH provider via SFTP files, bank statement via SFTP once a day.
- Matching levels? → assume: transaction level (our payment ↔ provider record) and settlement level (provider payout ↔ bank deposit).
- Tolerance? → assume: zero on amounts; dates within N banking days.
- Who works mismatches? → assume: a finance ops team needs a queue with owners, reasons and aging.
- Deadline? → assume: results by 10:00 the next business day.
- Does a large break block anything? → assume: yes, it can hold the next payout run for the affected provider account.

## Design

**Three-way:** ledger ↔ provider ↔ bank.

1. **Ingest.** Fetchers store raw files and API pages in S3 (immutable, checksummed), then parse into one shape:
```sql
recon_records(id, source,            -- ledger|stripe|ach_provider|bank
  external_id, amount_minor bigint, currency, value_date date, kind, reference,
  payout_ref, file_id, UNIQUE (source, external_id))
```
Re-ingesting the same file is a no-op.
2. **Level 1, transactions.** Join provider records to our payments by the ids we stored (PaymentIntent/charge id, ACH trace number). Set-based SQL joins, not row-by-row loops: 200k rows is seconds.
3. **Level 2, settlement.** Provider payout amount must equal the sum of its balance transactions (charges − refunds − fees − dispute withdrawals ± adjustments) and must equal the bank credit with that payout reference in the remittance info, within the date window.
4. **Results.**
```sql
recon_breaks(id, run_id, level, type,   -- missing_in_ledger|missing_in_provider|amount_mismatch|timing|duplicate
  amount_diff_minor, refs jsonb, status,  -- open|investigating|resolved|written_off
  owner, reason_code, expected_by date)
```
5. **Timing breaks** (other side expected tomorrow) carry `expected_by` and auto-close when matched; past it they escalate.
6. **Resolution** posts ledger adjustments with a reason code (never edits); write-offs need a second approver.
7. **Orchestration:** a scheduled job per source/day once files land; reruns over the same immutable inputs give the same result.
8. **Metrics:** auto-match %, open breaks by age and amount, alert if unexplained amount > threshold.

## Deep dives

**1. The $412.37 shortfall (the twist).** It's a level-2 break: bank credit ≠ expected payout. Drill down: list the payout's balance transactions from Stripe and anti-join them against ledger entries tagged with that payout. Whatever has no ledger counterpart explains the diff. Common causes: a dispute withdrawal (amount + dispute fee), a refund created in the Stripe dashboard, a fee different from the estimate (international or currency-conversion fee), a manual adjustment. Fix the root cause (usually a webhook type we don't handle, or a dashboard action that bypassed our API), ingest it, post the ledger entries, add a monitor.

**2. Bank lines without our ids.** A bank deposit is often one line for many payments. Chosen: match at aggregate level, provider payout ↔ deposit, using the payout reference. Rejected: fuzzy amount matching at transaction level; 50 tenants paying exactly 1,500.00 produce false matches.

**3. Day boundaries.** Stripe reports in UTC, the bank in local time, ACH settles on banking days only. Chosen: compare on value date with a banking-day window, record `expected_by`. Rejected: strict same-date matching (hundreds of false breaks every Monday).

**4. Totals hide errors.** +$100 missing and −$100 duplicated net to zero. Match at the lowest level with ids; use totals only as a final check.

## Traps

- Reconciling only daily totals; offsetting errors cancel out.
- Fixing a break by editing ledger rows instead of posting an adjustment.
- Fuzzy matching individual payments by amount and date.
- Mixing UTC and local dates.
- Row-by-row processing in Node with a query per record.
- Treating reconciliation as a report nobody acts on; it's a control with owners, aging and escalation.

## Say it (60–90 s)

I'd reconcile three ways: ledger, provider and bank. Fetchers store every raw file and API page in S3 unchanged, then parse them into one records table with source, external id, amount, currency, value date and payout reference, with a unique key so re-ingesting is safe. Level one matches provider records to our payments using the provider ids we stored at payment time, with set-based SQL. Level two checks that each provider payout equals the sum of its balance transactions and equals the bank credit carrying that payout reference. Everything that doesn't match becomes a break with a type, an amount, an owner and an expected-by date; timing breaks close automatically when the other side appears. Fixes are ledger adjustments with reason codes, and write-offs need a second approver. For the $412.37, the payout-level break tells me which payout; I list its balance transactions and anti-join against our ledger, and the leftover row, often a dispute withdrawal or a dashboard refund, is the answer. Then I fix the path that let it bypass us.

## Follow-ups

**Q:** Should a break stop payouts?
**A:** An unexplained shortfall above a threshold on a provider account holds the next payout run for that account. Timing breaks don't.

**Q:** Why daily and not real time?
**A:** Bank statements are daily. The real-time path is webhooks; Stripe-vs-ledger checks can run intraday via the API if needed.

**Q:** How does it improve over time?
**A:** Every manual reason code that repeats becomes a matching rule or a fixed upstream bug. Track auto-match rate as the KPI.

</details>

## Theory in the notes

- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [07-observability-reliability/01-sli-slo-error-budgets-alerting-runbooks.md](../../07-observability-reliability/01-sli-slo-error-budgets-alerting-runbooks.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
