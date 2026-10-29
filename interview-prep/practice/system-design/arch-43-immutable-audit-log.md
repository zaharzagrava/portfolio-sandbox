# arch-43. Immutable audit log

*Security · Medium*

## The question

"Our freelance marketplace needs an audit log: every change to freelancers' payout bank details, payouts, refunds, user roles, fee settings and every admin action must record who did it, what changed and when. It must be tamper-evident, kept for years, and queryable by entity and by actor. Expect about 2M audit events per day. Design it."

**Then:** "An auditor asks you to prove that a DBA with superuser access did not edit or delete audit rows from last March. How?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Every table, or a defined list of sensitive actions? → assume: a defined list (payout destinations, payouts, refunds, roles, fee settings, manual balance adjustments) plus every admin-tool action.
- Does "who" include services, API clients and impersonation? → assume: yes: actor type + id, plus `on_behalf_of` when support acts as a user.
- Retention? → assume: 7 years as a placeholder; legal sets the real period per record type and country.
- Query patterns? → assume: "history of entity X" and "what did actor Y do between dates"; seconds is fine; no full text.
- Should old/new values include bank numbers or personal data? → assume: masked values (last 4) plus a reference; never full numbers.
- Is "action succeeded, audit row missing" ever acceptable? → assume: no; the audit row is written in the same transaction.

## Design

1. **Write path.** Each service writes the change and its audit row in **one transaction**. A helper `audited(ctx, action, fn)` reads the actor, request id and reason from the request context (AsyncLocalStorage), so call sites can't forget them.
2. **Table**, partitioned by month:
```sql
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL, actor_id text NOT NULL, on_behalf_of text,
  action text NOT NULL,                 -- 'payout_account.updated'
  entity_type text NOT NULL, entity_id text NOT NULL,
  changes jsonb,                        -- changed fields only, masked
  request_id text, ip inet, reason text,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX ON audit_events (entity_type, entity_id, occurred_at);
CREATE INDEX ON audit_events (actor_id, occurred_at);
```
3. **Append-only in the DB.** The app role gets INSERT and SELECT only; a trigger rejects UPDATE and DELETE; TRUNCATE is revoked. This stops app bugs, not a superuser.
4. **Sealing.** A job every minute seals the window `[t, t+1 min)` once it is at least 5 minutes old: it hashes each row's canonical JSON, computes `seal = sha256(prev_seal || rows_hash)`, stores it in `audit_seals`, and writes it to an S3 bucket with **Object Lock in compliance mode** in a separate AWS account. The 5-minute delay matters: `now()` is the transaction start time, so a row can commit minutes after its `occurred_at`; `statement_timeout` and `idle_in_transaction_session_timeout` bound that delay.
5. **Verification.** A daily job recomputes seals from the DB and compares them with S3; a mismatch pages security.
6. **Retention.** ~1 KB/event → ~2 GB/day. Keep ~13 months hot in Postgres; then export each partition to Parquet in the Object Lock bucket, detach and drop it. Older queries go through Athena.

## Deep dives

**1. App-level capture vs triggers vs CDC.**
Problem: the row change alone doesn't say who or why.
Approach: app-level, same transaction, because only the app knows the actor, the reason and the business action ("refund approved", not "row updated"). Add triggers on the 3-4 most critical tables as a net: they read `current_setting('app.actor_id', true)` set with `SET LOCAL`; a NULL actor means someone bypassed the app, which is itself an alert.
Rejected: CDC only (Debezium). Complete for rows, but no who or why, and asynchronous, so a change can exist before (or without) its audit record.

**2. Tamper evidence against a superuser (the twist).**
Problem: a hash chain inside the same database proves nothing against someone who can rewrite rows and recompute the chain.
Approach: the proof is an anchor they can't reach: seals in S3 Object Lock compliance mode (no user, including the account root, can delete them or shorten retention) in an account the DBA has no access to. For last March: recompute March's seals from the archived Parquet and the DB and show they match the locked seals. Add database activity logging (pgaudit to CloudWatch, shipped to the same locked account) to show what privileged sessions ran.
Rejected: per-row chaining with a `prev_hash` column at insert. It serializes every insert on the chain head for no extra proof. Rejected: Amazon QLDB; AWS ended support for it in 2025.

**3. Query and size.**
Problem: billions of rows over years.
Approach: monthly partitions + two composite indexes keep hot queries in milliseconds; dropping partitions makes retention free of DELETE bloat.
Rejected: OpenSearch as the store. Fine as a secondary search view, but it's not tamper-evident and not a system of record.

## Traps

- **Using the application logger as the audit log**: async, can drop lines, no transactional link to the change.
- **Writing the audit row after commit or in a separate transaction**: a crash between them leaves an unaudited change.
- **"We hash-chain it, so it's tamper-proof"**: not without an external anchor; whoever can write can recompute.
- **Full before/after rows with bank numbers and personal data**: the audit table becomes the most sensitive table you own and an erasure problem.
- **Treating identity `id` order as commit order** when sealing: lower ids can commit later.
- **DELETE-based retention on one big table**: bloat and long locks; drop partitions instead.

## Say it (60–90 s)

I write the audit record in the same transaction as the change, through one helper that pulls the actor, the impersonated user if any, the request id and the reason from the request context. The table stores who, what action, which entity, the changed fields in masked form, and when. It's partitioned by month, with indexes on entity plus time and actor plus time, which covers the two queries compliance asks for. The application role can only insert and select, and a trigger blocks updates and deletes. That protects against bugs but not against a superuser, so tamper evidence comes from outside the database: every minute a job hashes the rows of a closed time window, chains the hash to the previous seal, and writes the seal to an S3 bucket with Object Lock in compliance mode, in a separate AWS account. A daily job recomputes the seals and alerts on any mismatch. To answer the auditor about last March, I recompute March's seals from the data and show they match the locked ones. After about a year, partitions move to Parquet in the locked bucket and are queried with Athena; the retention period itself comes from legal.

## Follow-ups

**Q:** A freelancer requests erasure. What happens to audit rows about them?
**A:** Audit rows reference IDs and masked values, so erasing the profile leaves them meaningful but not identifying. What remains is kept under the legal-obligation basis.

**Q:** Do you audit reads?
**A:** Sensitive ones: revealing a full bank account, exporting user lists, impersonation sessions. Not every page view.

**Q:** How fast is a 3-year history query?
**A:** Hot months: index lookup, milliseconds. Older: Athena over month-partitioned Parquet, seconds to a minute.

</details>

## Theory in the notes

- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
