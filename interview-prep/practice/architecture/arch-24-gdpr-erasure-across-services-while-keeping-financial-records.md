# arch-24. GDPR erasure across services while keeping financial records

*Data · Hard*

## The question

An EU-resident tenant asks us to delete all their personal data. It lives in Postgres (users, leases, payments, ledger), Mongo (raw PMS payloads), S3 (lease PDFs, ID documents), OpenSearch, the analytics warehouse, logs, and third parties (PSP, email provider). We are also required by law to keep financial records for years. Design the deletion flow.

**Then:** The tenant still owes the landlord two months' rent, and the landlord's PMS re-sends their profile to us via webhook every night.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Are we controller or processor for each data set? → assume: controller for the tenant's account and payments with us; possibly the landlord's processor for data that came from the landlord's PMS. If we're a processor, the landlord handles the request and we assist on their instruction. Legal decides per data set.
- Which laws apply? → assume: GDPR (we serve EU residents), plus Israel's Privacy Protection Law (Amendment 13 in force since August 2025) for Israeli data; retention periods from AML and tax law, which differ by country and record type.
- Deadline? → assume: GDPR's: without undue delay and within one month, extendable by two more months for complex requests if we tell the person.
- How do we verify the requester? → assume: logged-in account with re-authentication; otherwise a verification step.
- Is pseudonymisation acceptable for records we must keep? → assume: yes, with restricted access; pseudonymised data is still personal data under GDPR, so it's "retained on a legal basis", not "deleted".

## Design

1. **Inventory first.** A `pii_registry` per service: which personal data it holds, keyed by which subject id, and the retention basis. Without it, deletion is guesswork.
2. **Orchestrator:**
```sql
CREATE TABLE erasure_requests (
  id uuid PRIMARY KEY, subject_id uuid NOT NULL,
  received_at timestamptz NOT NULL, due_at timestamptz NOT NULL,
  status text NOT NULL, holds jsonb);           -- open dispute, unpaid balance, AML case
CREATE TABLE erasure_tasks (
  request_id uuid, system text, action text,     -- delete | pseudonymize | retain
  status text, attempts int DEFAULT 0, evidence jsonb, completed_at timestamptz,
  PRIMARY KEY (request_id, system));
```
3. **Flow:** verify identity → check holds → decide per data category → publish `SubjectErasureRequested` → each service's idempotent handler acts and reports back with evidence (counts, ids) → orchestrator retries and escalates stuck tasks before `due_at` → reply to the tenant listing what was deleted, what was kept and why.
4. **Per category:**
   - Profile, contact details, devices, marketing data: **delete**.
   - Payments, ledger, receipts: **retain** (legal obligation, GDPR Art. 17(3)(b)). Operational tables hold only `subject_id`; name and contact move to a `retained_identity` table only compliance can read, deleted when the retention period ends.
   - KYC documents: retain for the AML period in a restricted bucket, then delete.
   - Mongo raw payloads, S3 copies: delete, or **crypto-shred** where deletion is impractical.
   - OpenSearch: delete documents. Warehouse: facts carry pseudonymous ids only; delete the person's dimension row.
   - Logs: no PII by policy, 30-day retention, documented.
   - PSP and email provider: delete via their APIs where their own retention allows; notify recipients (Art. 19).
5. **Backups:** RDS automated backups expire (max 35 days). Keep an `erasure_log` of subject ids and re-apply it after any restore.
6. **Suppression:** a table of hashed external ids `(partner_id, external_tenant_id)` checked by ingestion (twist).

## Deep dives

**1. Keep vs delete in the same record set.**
Problem: the ledger must stay complete and balanced for years; the person's identity must go.
Approach: separate identity from transactions in the schema. Ledger, payments and receipts reference `subject_id`; identity lives in one table that is either deleted or moved to restricted retention. Erasure becomes "delete/restrict one row" instead of editing millions of financial rows.
Rejected: deleting payment rows (breaks balances and breaks the law). Rejected: a `deleted_at` flag (data is still there and still processed).

**2. Crypto-shredding: where the keys live.**
Problem: you can't edit backups or immutable archives.
Approach: encrypt per-subject PII with a per-subject data key (envelope encryption with a KMS key); deleting the data key makes all copies unreadable. The non-obvious part: if the wrapped keys sit in the main DB, its backups still contain them. Keep them in a separate store whose backups expire quickly. Don't create one KMS key per subject; KMS keys are billed monthly each.
Rejected: shredding everything. Search and analytics on encrypted fields get hard; use it for blobs and archives, plain deletion elsewhere.

**3. The twist: debt and re-ingestion.**
Problem: data needed for an unpaid-rent claim; the PMS re-creates the profile nightly.
Approach: keep what the claim needs (identity, lease, amounts owed) under Art. 17(3)(e), delete everything else now, tell the tenant, set a review date. For the PMS: the landlord's system is a separate source we can't delete from; we notify the landlord, and ingestion checks the suppression table and drops personal fields for suppressed ids (or stops processing them if the landlord confirms). If we are the landlord's processor for that data, we follow the landlord's instruction.
Rejected: "can't delete anything while a balance is open" (over-retention) and "delete everything now" (lose the claim).

## Traps

- **Soft delete as erasure**: `deleted_at` keeps the data and usually keeps processing it.
- **Deleting ledger or payment rows**: breaks double-entry and legal retention.
- **Forgetting copies**: backups, search index, warehouse, raw payloads, logs, third parties, email archives.
- **One retention number everywhere** ("7 years"): it differs by record type and country; legal owns the table.
- **Re-ingestion resurrecting deleted data** from a partner feed.
- **Calling a hashed email "anonymous"**: it's guessable and linkable; it's pseudonymous personal data.

## Say it (60–90 s)

I'd start with a registry of where personal data lives in each service and on what basis we keep it, because without that you can't promise deletion. An erasure request goes to an orchestrator that verifies the person, checks holds like an open dispute or an AML case, and decides per data category: delete, restrict, or retain with a legal basis. It publishes an event, every service deletes or pseudonymizes its part idempotently and reports back with evidence, and the orchestrator tracks the one-month deadline. The financial records stay: payments, ledger and receipts are kept under the legal-obligation exception, but they reference only a subject id, and the name and contact details move to a restricted table that's deleted when retention ends. Search documents, the warehouse dimension row, raw partner payloads and third-party copies are deleted, and logs don't hold personal data in the first place. For backups we keep an erasure log to re-apply after a restore, and crypto-shredding for archives we can't edit. If the tenant owes rent, we keep what the claim needs and delete the rest. If the PMS keeps sending the profile, we tell the landlord and add a suppression entry so ingestion drops it.

## Follow-ups

**Q:** How do you prove the deletion happened?
**A:** `erasure_tasks.evidence` per system, an audit event that references the request id (not the personal data), and the response sent to the person.

**Q:** Data in flight in SQS or Kafka?
**A:** Short retention on queues; consumers check the suppression list at apply time, so late messages don't recreate data.

**Q:** Analytics need history.
**A:** Facts keep pseudonymous ids and aggregates stay; the dimension row with identity is deleted, so the history can't be tied back to the person.

</details>

## Theory in the notes

- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [12-domain-rental-payments/01-pms-and-rent-payments.md](../../12-domain-rental-payments/01-pms-and-rent-payments.md)
