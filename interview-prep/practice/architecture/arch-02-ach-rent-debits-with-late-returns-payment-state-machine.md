# arch-02. ACH rent debits with late returns: payment state machine

*Payments · Hard*

## The question

Tenants pay rent by ACH debit. We submit debits through our payment provider; funds settle in 1-2 business days, but a return such as R01 (insufficient funds) can arrive after settlement, and a consumer can claim an unauthorized debit (R10 and similar) up to 60 days later. Design the payment state machine and what the tenant balance, the landlord payout and the PMS write-back see at each step. About 200k debits a month, 80% between the 1st and the 5th.

**Then:** A tenant's R01 return arrives after we already paid the landlord and posted the payment into the PMS. Walk me through what happens.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Which rail and provider? → assume: US ACH through a provider that builds Nacha files and reports settlement and returns by webhook and daily file. SEPA Direct Debit or Israeli bank debits have different windows; the state machine is the same, the timings are config per rail.
- Standard or Same Day ACH? → assume: standard, settlement 1-2 banking days after submission.
- Authorization? → assume: WEB debit authorized online, recurring authorization stored with text, timestamp, IP.
- Account verification at link? → assume: yes (open banking or micro-deposits). Nacha requires a fraud-detection system for WEB debits that includes account validation on first use of an account number.
- Who carries return risk? → assume: the landlord per contract; we front payouts and recover from future payouts.
- Retries? → assume: R01/R09 may be reinitiated, other codes not.

## Design

**States**
```
created → submitted → settled → cleared
             │           │         │
             └──► returned ◄───────┘      (returned is reachable from settled AND cleared)
created → canceled (before the provider cutoff); created/submitted → failed (rejected before entering the network)
```
- `settled`: provider says funds settled. Most returns (R01, R02, R03, R04) still come: the receiving bank has until the second banking day after settlement.
- `cleared`: our own state. Set by a job when settlement + N banking days pass with no return (N per provider, e.g. 3-5, covering provider reporting lag). Uses the banking-day calendar.
- `returned`: with code. Unauthorized codes (R05, R07, R10, R11) can arrive up to 60 calendar days after settlement for consumer accounts.

**Tables**
```sql
payments(id, lease_id, amount_minor bigint, currency, rail, status, provider_payment_id,
  settlement_date date, return_code text, returned_at, version int)
payment_transitions(payment_id, from_status, to_status, at, source, provider_event_id UNIQUE)
```
Every transition is a guarded update in one transaction with its ledger entries and outbox rows:
```sql
UPDATE payments SET status = 'returned', return_code = $2, version = version + 1
WHERE id = $1 AND status IN ('submitted','settled','cleared');   -- 0 rows → duplicate/stale, log and drop
```

**What each consumer sees**
| Step | Tenant | Ledger | Landlord payout | PMS |
|---|---|---|---|---|
| submitted | "Processing" | nothing posted, or a pending marker | not eligible | nothing |
| settled | "Paid" | Dr PSP clearing / Cr tenant receivable | not eligible yet | post payment |
| cleared | "Paid" | — | eligible | — |
| returned | "Returned: insufficient funds", balance owed | reversal entries | landlord payable debited | post NSF reversal |

**Return handling by code**
| Code | Meaning | Action |
|---|---|---|
| R01, R09 | insufficient / uncollected funds | may reinitiate, at most 2 times within 180 days of the original settlement (Nacha) |
| R02, R03, R04 | closed / not found / invalid account | stop; tenant must update the account |
| R05, R07, R10, R11 | unauthorized / revoked / not per terms | disable autopay mandate; new authorization needed |

## Deep dives

**1. When the landlord gets paid.** Chosen: payout eligibility at `cleared`, which covers the bulk of returns (NSF, closed accounts). The 60-day unauthorized tail is covered by recovering from future payouts, a per-landlord reserve sized by risk, and contract terms allowing a debit of the landlord's account. Rejected: pay at `submitted` (full NSF exposure); hold 60 days (landlords leave).

**2. The twist: R01 after payout and PMS posting.** `cleared → returned` is a legal transition. One transaction: guarded status update, ledger reversal (Dr tenant receivable / Cr PSP clearing), Dr landlord payable for the payout share (their balance may go negative), plus a return fee only if the lease allows it, plus outbox rows: PMS NSF reversal, tenant notification, retry decision. The next payout run nets the negative balance; if it stays negative past N days, collections per contract. R01 qualifies for reinitiation: schedule it (e.g. after the tenant's next payday or a few days later) and count attempts against the Nacha limit.

**3. Duplicate and out-of-order provider events.** A `settled` event can arrive after `returned`. Chosen: transitions with explicit allowed-from sets; events are inserted into an inbox keyed by provider event id first. Rejected: last-write-wins on a status column; it can turn `returned` back into `settled` and pay the landlord.

**4. Return-rate thresholds.** Nacha monitors originators: unauthorized returns 0.5%, administrative (R02, R03, R04) 3%, overall 15%. Track per rail and per landlord; account validation at link keeps administrative returns low.

## Traps

- Treating `settled` as final. Returns arrive after settlement by design.
- One status column overwritten by every webhook. Out-of-order events then resurrect returned payments.
- Retrying every return. Reinitiating R02 or R07 breaks Nacha rules; R01/R09 allow at most two reinitiations within 180 days.
- Stating one window for everything. Most returns: 2 banking days after settlement. Unauthorized consumer debits: 60 calendar days. SEPA and Israeli debits differ.
- Deleting or editing the original ledger entries on a return instead of posting a reversal.
- Paying the landlord at submission.

## Say it (60–90 s)

The core point is that settled is not final for ACH. My states are created, submitted, settled, cleared and returned, and returned is reachable from both settled and cleared. Most returns, like R01 insufficient funds, come within two banking days after settlement, so a job moves a payment to cleared after a few banking days with no return. Unauthorized returns can still come up to 60 days later. Each transition is a guarded update, status must be in an allowed set, in one transaction with its ledger entries and outbox rows, so duplicate or late provider events can't move a payment backwards. The tenant sees paid at settlement. The PMS gets the payment at settlement and an NSF reversal on return, because PMSs support that. The landlord's share becomes payable only at cleared. For a return after payout, I reverse the tenant entries, debit the landlord payable, net it from the next payout, and notify the tenant and the PMS. R01 can be reinitiated up to two times within 180 days; unauthorized codes stop the mandate. I'd also track Nacha's return-rate thresholds per landlord.

## Follow-ups

**Q:** No event marks "cleared". How do you set it?
**A:** A scheduled job: `settled` payments whose settlement date + N banking days has passed with no return move to `cleared`. N is config per provider; the calendar is a table of banking days.

**Q:** Should the PMS get the payment at settled or at cleared?
**A:** Settled. Landlords expect to see it quickly and PMSs have NSF reversal. Posting at cleared adds days of "where is my rent" tickets.

**Q:** What changes for SEPA Direct Debit?
**A:** Timings. Under SEPA Core the payer can get a no-questions refund for 8 weeks and claim an unauthorized debit for 13 months. Same states, different config and larger reserves.

</details>

## Theory in the notes

- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
