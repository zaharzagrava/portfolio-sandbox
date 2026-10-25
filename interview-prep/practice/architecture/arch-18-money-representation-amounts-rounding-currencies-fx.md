# arch-18. Money representation: amounts, rounding, currencies, FX

*Payments · Easy*

## The question

We collect rent in ILS from tenants in Israel, and some landlords are US-based. We take a 2.9% fee on card payments, and rent is often split between 2-4 roommates. How do you represent, store, compute and display money across the system (DB, Node services, API, UI)?

**Then:** A US landlord wants payouts in USD while tenants keep paying in ILS. Where does FX happen, and what exactly do you store?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Which currencies now and in 12 months? → assume: ILS and USD, both with 2 minor digits; the design must not hard-code 2.
- Who defines rounding for fees and splits: us, the landlord contract, or the PSP? → assume: our contract says fee is rounded half-up to the minor unit per payment; the PSP's own fee is whatever its settlement report says.
- Do we ever need precision below the minor unit (FX rates, per-unit utility rates)? → assume: yes for rates; any amount that moves money is whole minor units.
- Does FX happen at our PSP/bank, or do we convert ourselves? → assume: the PSP or bank converts and reports the executed amounts; we record them, we don't invent a rate.
- How do partners (PMS) send amounts: strings, floats, minor units? → assume: mixed; each adapter normalizes at the border.
- Display locales? → assume: he-IL and en-US.

## Design

1. **Type.** `type Money = { amount: bigint; currency: CurrencyCode }`, amount in minor units (agorot, cents). The number of minor digits comes from an ISO 4217 table (ILS 2, USD 2, JPY 0, KWD 3), never a constant 100.
2. **Storage.** Amount + currency pairs:
```sql
CREATE TABLE charges (
  id uuid PRIMARY KEY, lease_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL REFERENCES currencies(code)
);
```
Never float columns, never Postgres `money` (its formatting and input depend on `lc_monetary`, and it has no currency). `numeric` only for rates.
3. **Node.** node-postgres returns `int8` as a string by default. Parse to `BigInt` in the repository layer, once. A small `money.ts` module: `add`/`sub` throw on currency mismatch; `mulRate(m, rate, mode)` takes the rate as a decimal string and a required rounding mode. No default rounding mode: every call site names it.
4. **API.** `{"amount": "125000", "currency": "ILS"}`: minor units as a string so JS clients can't lose precision or do float math by accident.
5. **Fee.** Integer math: `fee = (amount * 290n + 5000n) / 10000n` is 2.9% rounded half-up for non-negative amounts. Store the rounded fee; never recompute it later from totals.
6. **Splits.** Largest remainder: ₪6,001.00 over 3 roommates = 2,000.34 / 2,000.33 / 2,000.33. The shares always sum to the total.
7. **Display.** `Intl.NumberFormat(locale, { style: 'currency', currency })` at the UI edge only. Never store or parse formatted strings.
8. **FX (twist).**
```sql
CREATE TABLE fx_conversions (
  id uuid PRIMARY KEY, payout_id uuid NOT NULL,
  sell_amount_minor bigint, sell_currency char(3),   -- ILS debited
  buy_amount_minor bigint,  buy_currency char(3),    -- USD credited
  rate numeric(20,10), rate_source text, quoted_at timestamptz, executed_at timestamptz
);
```
Both executed legs are the truth; the rate is derived and kept for display and audit. The landlord's statement shows the USD payout and the ILS it came from.

## Deep dives

**1. Where rounding happens.**
Problem: 2.9% per line item vs 2.9% of the total differ by an agora; recomputing a fee later from a stored total gives a third answer.
Approach: round once, at the moment an amount becomes a charge, fee or payout line; store the rounded value; downstream code only adds stored integers.
Rejected: carrying `numeric(20,6)` through the pipeline and rounding at display. The ledger then holds amounts no bank can move, and displayed lines stop summing to displayed totals.

**2. BigInt vs number in Node.**
Problem: `Number` is exact for integers up to 2^53−1 (about 9×10^15 minor units), so overflow is not the real risk. The real bugs are float math (`amount * 0.029`) and pg's int8-as-string (`"100" + 5 === "1005"`).
Approach: `bigint` (or a branded integer type) end to end, a lint rule against arithmetic on Money fields outside `money.ts`.
Rejected: a decimal library for all amounts. It works, but it allows 125000.5 minor units to exist; integer minor units make "whole agorot only" a type invariant.

**3. FX ownership and timing.**
Problem: who sets the rate, when it is locked, who absorbs the move between quote and execution.
Approach: the provider executes; we store both executed legs. If we show a quote first, it has an expiry and the quote is stored separately; any difference between quoted and executed is booked explicitly as FX gain/loss, not hidden in rounding.
Rejected: storing only the USD amount and a rate, deriving ILS when needed. Rounding makes it irreversible, and reconciliation against the bank's ILS debit breaks by agorot.

## Traps

- **Floats anywhere**, including `numeric` in the DB but `parseFloat` in Node: precision is lost in the app layer.
- **Hard-coding 2 decimals / dividing by 100**: breaks the day you add a 0- or 3-digit currency.
- **Rounding each roommate's share independently**: shares sum to total ± 1 agora; the bank debit and the ledger disagree.
- **Storing or parsing formatted strings**: `he-IL` output can contain invisible bidi control characters; parsing it back is fragile.
- **`SUM(amount)` without `GROUP BY currency`**: adds shekels to dollars.
- **Converting history at today's rate** in reports: use the rate executed at the time.

## Say it (60–90 s)

I represent money as an integer number of minor units plus a currency code, everywhere. In Postgres that's a bigint amount column and a char(3) currency column, never float and never the money type. In Node I parse the bigint into BigInt once in the repository layer, because node-postgres returns int8 as a string, and all arithmetic goes through one small money module that refuses to mix currencies and requires an explicit rounding mode. The API sends amounts as strings of minor units with the currency. Minor digits come from the ISO currency table, so a three-digit currency doesn't break anything. Fees are computed with integer math and rounded once, when the fee is created, and stored. Splits between roommates use largest remainder, so the shares always add up to the rent. Formatting with Intl.NumberFormat happens only in the UI. For a US landlord paid in USD from ILS rent, the bank or PSP does the conversion, and I store both executed legs plus the rate and its source, so the landlord's statement and our reconciliation both match what actually moved.

## Follow-ups

**Q:** Why not Postgres `numeric` for amounts?
**A:** It's exact, so it's acceptable. Bigint minor units are smaller and faster, and make "no fractional agorot" structural. I keep `numeric` for rates.

**Q:** How do you add a currency with 3 minor digits?
**A:** Add it to the currencies table. The money module and formatting read the exponent from there; no code assumes 100.

**Q:** The PSP charges its fee in USD on an ILS payment. How do you record it?
**A:** As reported: amount, currency, and the PSP's own conversion if it shows one. Ledger entries stay per currency; cross-currency moves only through recorded FX rows.

</details>

## Theory in the notes

- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
- [01-javascript-typescript/01-javascript-internals.md](../../01-javascript-typescript/01-javascript-internals.md)
