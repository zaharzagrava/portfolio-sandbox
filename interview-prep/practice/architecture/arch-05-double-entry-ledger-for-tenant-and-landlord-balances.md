# arch-05. Double-entry ledger for tenant and landlord balances

*Data · Medium*

## The question

We need a ledger for tenant and landlord balances: rent charges, payments, fees, refunds, payouts. Finance wants balances that always add up and can be explained line by line; auditors want history nobody can edit. About 5M entries a month, peaks of ~100 writes/s on the 1st. Design the data model and the write API.

**Then:** A bug posted 3,000 late fees with the wrong amount last week. How do you fix it, and how do you show a balance "as of" last Tuesday?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Whose books? → assume: the platform's view (what we hold, owe and earn). The PMS keeps its own tenant ledger; we sync to it, we don't replace it.
- Currencies? → assume: several (USD, ILS), never mixed inside one transaction without explicit FX accounts.
- Reads? → assume: real-time balance per account, statements per period, as-of queries for finance.
- Pending money? → assume: the ledger records facts (settled, returned), payment status lives in the payments table.
- Downstream accounting system? → assume: a daily journal export (NetSuite or similar).
- Separate service or same database? → assume: same Postgres as payments, so a payment transition and its entries commit together.

## Design

**Accounts** per party and purpose: `tenant:{id}:receivable`, `owner:{id}:payable`, `platform:fee_revenue`, `platform:psp_clearing:stripe`, `platform:bank:operating`, `platform:psp_fee_expense`.

```sql
ledger_accounts(id, code UNIQUE, owner_type, owner_id, currency, normal_side)   -- 'debit'|'credit'
ledger_transactions(id uuid PRIMARY KEY, idempotency_key UNIQUE, kind, effective_date date,
  created_at timestamptz DEFAULT now(), reverses_id uuid NULL, memo, metadata jsonb)
ledger_entries(id bigserial, transaction_id, account_id, direction char(1),   -- 'D'|'C'
  amount_minor bigint CHECK (amount_minor > 0), currency)
account_balances(account_id PRIMARY KEY, balance_minor bigint, version bigint)  -- cache
```

**Write API** (a module function, not an HTTP service):
```ts
postTransaction({ idempotencyKey, kind, effectiveDate, entries: [{ account, direction, amount }] })
```
One Postgres transaction: insert transaction (`ON CONFLICT (idempotency_key)` → return the existing one), insert entries, check Σ debits = Σ credits per currency (in code and in a deferred constraint trigger), update cached balances in sorted account-id order to avoid deadlocks.

**Example:** tenant pays 1,500.00 by card, Stripe fee 45.00
```
Dr psp_clearing:stripe 1,500.00   Cr tenant:17:receivable 1,500.00
Dr psp_fee_expense        45.00   Cr psp_clearing:stripe     45.00
```

**Immutability:** the app role has `INSERT, SELECT` only on ledger tables; no `UPDATE`/`DELETE`. Corrections are new transactions with `reverses_id`.

**Balances:** truth = Σ entries. `account_balances` is a cache, rebuilt and compared nightly; mismatch = alert. Monthly closing snapshots per account make long histories cheap: balance = snapshot + Σ entries since.

**Indexes:** `(account_id, effective_date)`, `(account_id, created_at)`. Partition entries by month at higher volume.

## Deep dives

**1. Fixing 3,000 wrong fees (the twist).** For each wrong fee: a reversing transaction (`reverses_id` = original, same `effective_date`, `created_at` = now) and a correct one. Idempotency key `fix-INC-123:{original_tx_id}` makes the batch rerunnable. Run as a reviewed script with a dry-run diff first; write back corrections to the PMS through the outbox. Rejected: `UPDATE` the amounts; statements already sent no longer match, and the audit trail is gone.

**2. "As of Tuesday" has two meanings.** `effective_date` = when it happened in business terms; `created_at` = when we recorded it. "What did we think on Tuesday" = entries with `created_at ≤ Tuesday`. "What was the true balance on Tuesday" = entries with `effective_date ≤ Tuesday`, including corrections posted later. Finance needs both; with two dates on every transaction both are a single indexed query.

**3. Hot accounts.** Every payment touches `psp_clearing`; a single cached balance row becomes a lock queue on the 1st. Chosen: no cached balance for system accounts (compute from entries + snapshot when needed), or split the cache into N bucket rows summed on read. Rejected: SERIALIZABLE isolation everywhere (retry storms under load).

**4. Overdraft rules.** Accounts that must not go negative (an owner's payable at payout time) are checked inside the transaction after locking that balance row. Receivables may go negative (credit balance).

## Traps

- A single `balance` column updated in place with no entries; it can't be explained or audited.
- Floats or NUMERIC with fractional cents; use bigint minor units and explicit rounding rules.
- Allowing `UPDATE`/`DELETE` on entries, even "just for fixes".
- One timestamp only; you can't answer both "as recorded" and "as effective" questions.
- Putting the ledger in a separate service with async writes for a single-database app; the payment and its entries can then disagree.
- Mixing currencies in one balance.

## Say it (60–90 s)

I'd model accounts per party and purpose: tenant receivable, owner payable, fee revenue, PSP clearing, bank, fee expense. A ledger transaction has a unique idempotency key, a kind, an effective date and a created-at time, and it has two or more entries, each with an account, a direction and a positive amount in integer minor units. The write API is one function that inserts the transaction and entries in one Postgres transaction and checks that debits equal credits per currency, both in code and with a deferred constraint trigger. The app role can't update or delete ledger rows; every correction is a reversing transaction that points to the original. The balance is the sum of entries; a cached balance row exists for speed and is verified nightly, and monthly snapshots keep long histories fast. For the bug, I'd post a reversal and a correct transaction per wrong fee, with deterministic idempotency keys so the script can rerun. Because each transaction has both effective date and created-at, I can show the balance as we knew it on Tuesday and the true balance for Tuesday after corrections.

## Follow-ups

**Q:** Why not just events and projections?
**A:** The ledger is the event log for money. Double-entry adds an invariant, every transaction sums to zero, that rejects a whole class of bugs at write time.

**Q:** Contention on the 1st?
**A:** Short transactions, sorted lock order, no cached balance on hot system accounts. 100 writes/s is small for Postgres.

**Q:** When would you move to a dedicated ledger database?
**A:** When throughput is in the tens of thousands of transfers per second or the ledger needs its own isolation and SLA. Not at 5M entries a month.

</details>

## Theory in the notes

- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
