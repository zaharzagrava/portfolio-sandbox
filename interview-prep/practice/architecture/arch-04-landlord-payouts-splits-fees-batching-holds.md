# arch-04. Landlord payouts: splits, fees, batching, holds

*Payments · Hard*

## The question

Tenants pay rent to our platform; we take a platform fee and pay out. One property manager (PM) has 2,000 units owned by 300 owners: each payment splits into an 8% management fee for the PM and the rest for the owner. Each payee gets at most one payout per day. Design how a tenant payment becomes payouts, including fees, batching and holds.

**Then:** An owner changes their payout bank account at 02:00 and a $180k payout is scheduled for 06:00. Separately, another owner's balance is negative after a reversal. How does the payout run handle both?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Who holds the funds? → assume: a PSP platform product (Stripe Connect or similar) or a partner bank FBO account. Holding funds for others may require money-transmission licensing depending on the country and state, so we don't hold them in our own account.
- Split rules? → assume: per PM agreement, versioned; PM fee %, platform fee charged to the tenant as a separate convenience fee.
- Payout rail and cadence? → assume: ACH/local bank transfer, daily run at 06:00 PM-local time, minimum payout $1.
- Who absorbs reversals? → assume: the owner (or the PM if the contract says so); we front and recover.
- Currency? → assume: one currency per payee account, no FX.
- Statement needs? → assume: owners reconcile each payout line by line in their PMS.

## Design

**1. Allocation on payment success** (same transaction as the payment's ledger entries). Load the split rule version in force; compute shares in integer cents; give rounding remainders to a fixed party (the owner):
```
rent 2,000.00 → PM fee 8% = 160.00 → owner 1,840.00
Dr tenant receivable … (payment)    Cr owner:42:payable 1,840.00    Cr pm:7:payable 160.00
```
Each credit entry gets `available_at`: card = provider's funds availability; ACH = when the payment reaches `cleared`.

**2. Holds** are rows, not flags:
```sql
payout_holds(id, payee_account_id, reason, amount_minor NULL,  -- NULL = everything
  created_by, created_at, released_at, released_by)
```
Reasons: risk review, bank account change, KYC incomplete, dispute reserve.

**3. Payout run** (per PM timezone, 06:00):
```
available = Σ payable entries with available_at ≤ now and not yet in a payout
          − Σ debit entries (reversals, fees)        -- netting
          − active partial holds
skip if: full hold, KYC not approved, bank account not verified, available < minimum
```
Creates `payouts` + `payout_items`, then an outbox command. A side-effect worker calls the PSP with idempotency key = payout id.
```sql
payouts(id, payee_account_id, bank_account_id, amount_minor, currency, run_date, status,  -- created|submitted|paid|failed
  provider_payout_id, UNIQUE (payee_account_id, run_date))
payout_items(payout_id, ledger_entry_id UNIQUE)   -- an entry is paid out at most once
```
**4. Payout states:** `created → submitted → paid | failed`. Failed (closed account) → reversing ledger entries, items released, bank account `needs_update`, notify.

**5. Statements:** each payout lists its items: tenant, unit, period, gross, fee, net. Owners match it to the bank line by payout id in the descriptor where the rail allows.

## Deep dives

**1. Bank account change at 02:00 (the twist).** Payout-account takeover is a top fraud pattern for platforms. Chosen: a new bank account starts `pending_verification` (ownership check via open-banking name match or micro-deposits), change requires recent MFA, notification goes to the old email/phone and to PM admins, and a cool-down (e.g. 72 h) holds payouts above a threshold. The 06:00 run sees a full hold → no payout today; the $180k stays as balance. Rejected: paying to the new account immediately; also rejected: silently paying the old account (the owner may have closed it, and if the change is legit, ops confirms and releases early).

**2. Negative balance.** A reversal is a debit entry on the owner's payable, so the run nets it: the owner's available amount is negative → no payout, carry forward, alert after N days, recover from future rent. Net across owners of one PM only if the contract makes the PM liable. Rejected: paying gross and chasing the debt separately.

**3. How long to hold.** Card disputes can come months later and ACH unauthorized returns up to 60 days after settlement; nobody accepts a 60-day hold. Chosen: hold until the bulk of returns is past (ACH `cleared`), plus a rolling reserve per PM sized by risk (e.g. a % of volume for N days), plus the contractual right to debit the payee. Rejected: per-payment holds for the full dispute window.

**4. Never pay twice.** `UNIQUE(ledger_entry_id)` in `payout_items`, `UNIQUE(payee, run_date)`, PSP idempotency key = payout id. A timeout on the PSP call is "unknown": query the PSP by our id before retrying.

## Traps

- A mutable `balance` column as the payout source; nobody can explain which payments a payout contains.
- Splitting with floats or rounding each share independently; the shares stop summing to the payment.
- Making ACH funds available at payment success.
- Accepting payout bank details from a PMS payload or an unverified form.
- One payout per tenant payment; bank fees and 2,000 lines for the owner to reconcile.
- Holding other people's money in your own bank account without checking licensing.

## Say it (60–90 s)

When a payment succeeds, in the same transaction I allocate it: load the split rule version for that PM, compute the PM fee and the owner share in integer cents with the rounding remainder going to the owner, and post credits to each payee's payable account. Each credit has an available-at time: card funds when the provider makes them available, ACH only after the return window I call cleared. Holds are rows with a reason, not flags. A daily run per PM timezone computes each payee's available amount from entries, nets any reversals, skips payees with a full hold, missing KYC or an unverified bank account, and creates one payout with payout items. Payout items have a unique constraint on the ledger entry, so an entry is paid at most once, and the PSP call uses the payout id as idempotency key. For the twist: a new bank account needs verification, recent MFA and a cool-down, and we notify the old contact, so the $180k is held, not sent. A negative owner balance just means no payout; it's netted from future rent and alerted if it lasts.

## Follow-ups

**Q:** The PM changes their fee from 8% to 7% on the 15th.
**A:** New rule version with an effective date. Allocations store `rule_version_id`; history is never recomputed.

**Q:** A payout fails because the account is closed.
**A:** PSP reports failure (for ACH, an R02-type return of the credit). Reverse the payout entries, release its items back to available, mark the bank account `needs_update`, notify.

**Q:** Why not pay out instantly per payment?
**A:** Fees per transfer, unreconcilable statements, and no time for returns. Daily batching per payee is what PMs reconcile against.

</details>

## Theory in the notes

- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
