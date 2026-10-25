# arch-10. Recurring autopay scheduler

*Payments · Medium*

## The question

Rent is due on the 1st. 150k tenants have autopay, across US time zones and in Israel, paying by ACH or card. Tenants can choose a pay day from the 1st to the 5th, pause for a month or skip a month. Design the scheduler that creates the charges.

**Then:** The 1st falls on a Sunday and Monday is a US bank holiday, and our scheduler was down from 23:00 to 02:00 UTC that night. What gets charged when?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Does "pay on the 1st" mean initiate on the 1st or funds arrive by the 1st? → assume: initiate on the chosen day in the property's time zone; landlords have a grace period.
- Amount? → assume: the open rent balance computed shortly before the run, shown to the tenant in advance.
- Pre-debit notice? → assume: yes. For US consumer recurring debits that vary in amount, Regulation E requires notice at least 10 days before (unless the consumer chose notice only outside a range). Other countries have their own rules.
- Retries? → assume: ACH R01/R09 may be reinitiated at most twice within 180 days (Nacha); card soft declines retried within network limits.
- Time zone source? → assume: the property's IANA zone.
- Calendars? → assume: per rail and country. ACH uses Federal Reserve banking days; Israel's banking week and holidays differ (weekend is Friday-Saturday).

## Design

**Tables**
```sql
autopay_plans(id, tenant_id, lease_id, payment_method_id, pay_day smallint CHECK (pay_day BETWEEN 1 AND 5),
  amount_rule text,  -- full_balance | fixed
  status text,       -- active | paused
  timezone text)
autopay_occurrences(id, plan_id, period date,   -- rent month, e.g. 2026-11-01
  local_date date, run_at timestamptz,
  status text,       -- planned|notice_sent|skipped|initiated|succeeded|failed|canceled
  amount_minor bigint, payment_id uuid, skip_reason text,
  UNIQUE (plan_id, period))
business_days(rail text, country text, day date, is_business_day bool, PRIMARY KEY (rail, country, day))
```

**1. Planner** (daily): for each active plan, materialize occurrences for the next ~15 days. `local_date` = pay day in that period, adjusted with the rail's calendar (card: no adjustment; ACH: next banking day by default, configurable per landlord). `run_at` = 06:00 local on `local_date`, converted with the IANA zone (06:00 always exists; 02:00 doesn't on DST change days). Skip/pause → `skipped`.

**2. Notice:** at T−10 days for varying amounts (Reg E), a reminder at T−3 with the expected amount and date.

**3. Executor** (every minute, any replica): claim `run_at ≤ now() AND status IN ('planned','notice_sent')` with `FOR UPDATE SKIP LOCKED`, batches of 200. For each: recompute the open balance (zero → `skipped`, "already paid"), call the payment service with idempotency key `autopay:{occurrence_id}`, set `initiated`. Overdue rows are just rows: after downtime they're picked up, with a max-lateness guard (e.g. > 2 days late → ask the tenant to confirm).

**4. Results:** payment events update the occurrence; failures create a retry occurrence (attempt n) per rail rules.

**5. Load:** 150k occurrences on day 1 spread naturally by time zone, and further with jitter over 06:00-09:00 local; the executor's rate stays under the PSP's limits. ACH submissions must reach the provider before its daily cutoff to make that day's file.

## Deep dives

**1. Time zones.** "The 1st" is a local date. A cron at 00:00 UTC is still the evening of the previous day in the US, so tenants get charged a day early. Chosen: store local date + zone, compute `run_at` when planning, re-plan future unexecuted occurrences if the property zone is corrected. Rejected: computing "is it the 1st" in UTC at run time.

**2. Holidays (the twist).** ACH entries only settle on banking days: Sunday the 1st + Monday holiday → the effective entry date is Tuesday the 3rd. Policy choice: next banking day (rent lands later, inside the grace period) or previous banking day (tenant charged before the due date, overdraft risk). Chosen: next banking day by default, per-landlord override, and the notice states the real date. Card plans run on Sunday because card rails don't stop. Late fees must use the same calendar so the delay isn't penalized.

Israeli tenants paying through Israeli rails follow the Israeli calendar: Sunday is a banking day there and the US holiday doesn't apply.

**3. Downtime (the twist).** With `run_at` at 06:00 local, nothing was due in 23:00-02:00 UTC: 06:00 in US zones is 10:00-16:00 UTC, and 06:00 in Israel is 03:00 or 04:00 UTC. Had anything been due, it would simply be overdue at 02:00 and claimed then. No duplicates: `UNIQUE(plan_id, period)` and the idempotency key mean a crash after creating the payment but before marking the occurrence just returns the same payment on retry.

**4. Exactly one charge per period.** Rejected: an in-process cron in every replica (N charges), or one leader looping and charging inline (a crash halfway leaves the rest unpaid with no record of where it stopped).

## Traps

- Running `node-cron` in every instance.
- Deciding "today is the 1st" in UTC.
- Hardcoding weekends and holidays; Israel and the US differ, and holiday dates change yearly.
- Charging an amount fixed at plan creation after lease charges changed, or a changed amount without the required notice.
- Retrying ACH returns beyond Nacha's limit, or retrying hard card declines.
- Allowing pay days 29-31; February breaks them.

## Say it (60–90 s)

I'd split planning from execution. A daily planner materializes one occurrence per plan per rent period, with a unique constraint on plan and period. It computes the local date from the tenant's pay day, moves it to the next banking day for ACH using a calendar table per rail and country, and sets run-at to 6 a.m. in the property's time zone. Skips and pauses just mark that occurrence skipped. Notices go out ten days before for varying amounts, which Reg E requires in the US. An executor on every replica claims due occurrences with SKIP LOCKED, recomputes the open balance, skips if it's already paid, and calls the payment service with an idempotency key derived from the occurrence id. So a crash or a duplicate run can't charge twice. For the twist: card plans charge on Sunday; ACH plans get Tuesday as the entry date, the first banking day, and the notice already said so. Israeli tenants follow the Israeli calendar, where Sunday is a banking day. And the downtime touches nothing: 6 a.m. local is after 2 a.m. UTC in every zone we serve, and anything overdue would just be claimed when the executor comes back.

## Follow-ups

**Q:** The tenant pays manually on the 30th; autopay runs on the 1st.
**A:** The executor recomputes the open balance at run time, counting pending payments. Zero → skip with reason "already paid".

**Q:** A saved card expires before the run date.
**A:** Use the provider's card account updater; if still expired at T−7, notify the tenant to update the card.

**Q:** Why materialize occurrences instead of computing on the fly?
**A:** They give a row to lock, a unique key per period, an audit trail of skips and notices, and catch-up after downtime for free.

</details>

## Theory in the notes

- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
