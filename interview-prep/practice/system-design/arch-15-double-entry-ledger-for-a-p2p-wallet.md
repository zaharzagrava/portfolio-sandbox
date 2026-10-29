# arch-15. Double-entry ledger for a P2P wallet

*Fintech · Medium*

## The question

"We run a peer-to-peer wallet app: users top up by card, send money to friends instantly, receive cashback, and withdraw to their bank. 3M users, ~20M transfers a month, peaks of ~500 transfers/s on Friday evenings. Balances must never go negative, every balance must be explainable line by line, and auditors want history nobody can edit. Design the ledger and the transfer API."

**Then:** "A bug credited 3,000 cashback rewards twice last week, and some users have already spent the money. How do you fix it, and how do you show a user's balance 'as of last Tuesday'?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Currencies? → assume: one per wallet (USD or EUR); cross-currency transfers go through explicit FX accounts, never mixed in one transaction.
- Instant means? → assume: the receiver's balance updates in the same database transaction as the sender's; no "pending" for internal transfers.
- Pending money from outside? → assume: card top-ups credit the wallet when the PSP confirms; bank withdrawals debit immediately into a `withdrawals_in_flight` account until settled or returned.
- Regulation? → assume: customer funds are held as e-money and must be safeguarded; daily we prove customer liabilities in the ledger ≤ the safeguarded bank balance. Exact rules depend on the licence and country.
- Numbers → assume: 20M transfers/month × 2-4 entries ≈ 60M entries/month, ~720M/year, ~100 B each ≈ 70 GB/year plus indexes. Peak 500 transfers/s ≈ 1-2k entries/s: fine for one Postgres primary.
- Ledger placement → assume: same Postgres as the wallet service, so a transfer and its entries commit together.

## Design

**Accounts:** `user:{id}:wallet`, `user:{id}:recovery` (money they owe us), `platform:topup_clearing:{psp}`, `platform:withdrawals_in_flight`, `platform:cashback_expense`, `platform:fee_revenue`, `platform:bank:safeguarding`.

```sql
ledger_accounts(id, code UNIQUE, owner_id, currency, normal_side, allow_negative bool)
ledger_transactions(id uuid PRIMARY KEY, idempotency_key text UNIQUE, kind text,
  effective_at timestamptz, created_at timestamptz DEFAULT now(), reverses_id uuid, memo, metadata jsonb)
ledger_entries(id bigserial, transaction_id uuid, account_id, direction char(1),  -- 'D' | 'C'
  amount_minor bigint CHECK (amount_minor > 0), currency char(3))
account_balances(account_id PRIMARY KEY, balance_minor bigint, version bigint)
```

**Transfer API:** `POST /transfers {toUserId, amount, currency}` with `Idempotency-Key`. One transaction:
1. `INSERT INTO ledger_transactions … ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`; no row → return the existing transfer.
2. `SELECT … FROM account_balances WHERE account_id IN ($sender, $receiver) ORDER BY account_id FOR UPDATE` (sorted order = no deadlocks between A→B and B→A).
3. Sender balance < amount and `allow_negative = false` → rollback, 422 `insufficient_funds`.
4. Insert entries: `D user:A:wallet`, `C user:B:wallet` (a liability account: credit increases what we owe B).
5. Update both cached balances; a deferred constraint trigger checks Σ debits = Σ credits per currency per transaction.
6. Outbox: push notification to the receiver.

**Immutability:** the app role has `INSERT, SELECT` only on ledger tables. Corrections are new transactions with `reverses_id`.

**Truth vs cache:** balance = Σ entries; `account_balances` is a cache, rebuilt and compared nightly (any mismatch pages). Monthly snapshots per account keep "as of" queries fast: snapshot + Σ entries since.

**Indexes:** `ledger_entries (account_id, effective_at)`, `(account_id, created_at)`; partition by month.

## Deep dives

**1. Fixing double cashback (twist, part 1).** For each duplicate: a reversing transaction (`reverses_id` = the duplicate, idempotency key `fix-INC-512:{tx_id}`) so the script can rerun safely, run first as a dry run producing a diff for review. For users who already spent it, a full reversal would make the wallet negative, which the constraint forbids. Chosen: debit the wallet up to its available balance, put the remainder on `user:{id}:recovery` (an asset: they owe us), block withdrawals while recovery > 0, and recover from future incoming money; amounts below a threshold are written off to `cashback_expense` with a second approver. Rejected: `UPDATE` the original entries (statements and audit trail break); forcing balances negative silently.

**2. "As of Tuesday" has two meanings (twist, part 2).** `effective_at` = when it happened in business terms; `created_at` = when we recorded it. "What did the app show on Tuesday" = entries with `created_at ≤ Tuesday`. "What was the correct balance on Tuesday" = entries with `effective_at ≤ Tuesday`, including the corrections posted later with the original's `effective_at`. Support and auditors need both; two timestamps make each a single indexed sum from the monthly snapshot.

**3. Hot system accounts.** Every cashback debits `platform:cashback_expense`; every top-up touches `topup_clearing`. A single cached balance row for those becomes a lock queue at 500 tx/s. Chosen: no cached balance for system accounts (they have `allow_negative = true` and nobody checks them per transaction; compute from entries when needed), or split them into N sub-accounts. User wallets keep the locked cache because the non-negative check needs it. Rejected: SERIALIZABLE everywhere (retry storms at peak).

## Traps

- A `balance` column updated in place with no entries: can't be explained or audited.
- Floats, or NUMERIC with fractional cents: use bigint minor units with explicit rounding rules.
- Checking the balance with a SELECT and debiting in a separate statement without a lock: two concurrent transfers both pass and the wallet goes negative.
- Locking the two accounts in request order: A→B and B→A at the same moment deadlock.
- One timestamp only: you can't answer both "as recorded" and "as effective" questions.
- Putting the ledger behind an async service for a single-database app: the transfer and its entries can disagree.

## Say it (60–90 s)

Each user has a wallet account, and the platform has accounts for top-up clearing, withdrawals in flight, cashback expense, fees and the safeguarding bank account. A ledger transaction has a unique idempotency key, a kind, an effective time and a created time, plus two or more entries, each with an account, a direction and a positive amount in integer minor units. A transfer is one Postgres transaction: insert the ledger transaction with on-conflict-do-nothing on the key, lock the two balance rows in account ID order so opposite transfers can't deadlock, check the sender has enough, insert the debit and credit, update both balances, and write an outbox row for the notification. A deferred trigger checks that debits equal credits. The app role can't update or delete ledger rows; balances are a cache verified nightly against the sum of entries. For the double cashback, I post a reversal per duplicate with deterministic keys, reviewed as a dry run first. If the user already spent it, the wallet goes to zero and the rest goes to a recovery account they owe, with withdrawals blocked, or small amounts get written off with approval. Two timestamps let me show both what the app displayed on Tuesday and the corrected balance for Tuesday.

## Follow-ups

**Q:** Why double-entry and not just transfer rows with from/to?
**A:** Top-ups, fees, cashback, FX and withdrawals all touch accounts beyond two users. Double-entry gives one invariant (every transaction sums to zero) that rejects a whole class of bugs at write time and lets finance reconcile every account the same way.

**Q:** When would you move to a dedicated ledger database?
**A:** At tens of thousands of transfers per second or when the ledger needs its own SLA and team; then something purpose-built (e.g. TigerBeetle) or sharding by account. Not at 500/s.

**Q:** A withdrawal comes back returned by the bank three days later.
**A:** The withdrawal posted `D user:{id}:wallet / C platform:withdrawals_in_flight`. The return is a new transaction referencing it: `D platform:withdrawals_in_flight / C user:{id}:wallet`, so the money is owed to the user again (plus a fee entry if our terms charge one). The original is never edited.

</details>

## Theory in the notes

- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
