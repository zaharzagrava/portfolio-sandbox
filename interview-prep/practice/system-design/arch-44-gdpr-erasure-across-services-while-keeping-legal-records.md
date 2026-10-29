# arch-44. GDPR erasure across services while keeping legal records

*Data · Hard*

## The question

"An EU customer of our online travel agency asks us to delete all their personal data. It lives in Postgres (customers, bookings, payments, ledger), MongoDB (raw supplier booking payloads), S3 (passport scans for flights that need passenger data), OpenSearch (support search), the analytics warehouse, logs, and third parties (payment provider, email provider, the airlines and hotels we booked with). We're also required by law to keep financial and tax records for years. Design the deletion flow."

**Then:** "The customer has an open card chargeback with us and a trip booked for next month. And an airline loyalty partner re-sends their profile to us every night."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Are we controller or processor for each data set? → assume: controller for the customer's account, bookings and payments with us. Airlines and hotels are separate controllers for the data we passed them. Legal decides per data set.
- Which laws apply? → assume: GDPR, plus retention periods from tax and accounting law, which differ by country and record type.
- Deadline? → assume: GDPR's: without undue delay and within one month, extendable by two further months for complex requests if we tell the person within the first month.
- How do we verify the requester? → assume: logged-in account with re-authentication; otherwise a verification step.
- Is pseudonymisation acceptable for records we must keep? → assume: yes, with restricted access. Pseudonymised data is still personal data under GDPR, so it's "retained on a legal basis", not "deleted".

## Design

1. **Inventory first.** A `pii_registry` per service: which personal data it holds, keyed by which subject id, and the retention basis. Without it, deletion is guesswork.
2. **Orchestrator:**
```sql
CREATE TABLE erasure_requests (
  id uuid PRIMARY KEY, subject_id uuid NOT NULL,
  received_at timestamptz NOT NULL, due_at timestamptz NOT NULL,
  status text NOT NULL, holds jsonb);           -- open dispute, upcoming trip, fraud case
CREATE TABLE erasure_tasks (
  request_id uuid, system text, action text,     -- delete | pseudonymize | retain
  status text, attempts int DEFAULT 0, evidence jsonb, completed_at timestamptz,
  PRIMARY KEY (request_id, system));
```
3. **Flow:** verify identity → check holds → decide per data category → publish `SubjectErasureRequested` → each service's idempotent handler acts and reports back with evidence (counts, ids) → the orchestrator retries and escalates stuck tasks before `due_at` → reply to the customer listing what was deleted, what was kept and why.
4. **Per category:**
   - Profile, contact details, devices, marketing data, saved travellers: **delete**.
   - Payments, ledger, invoices: **retain** (legal obligation, Art. 17(3)(b)). Operational tables hold only `subject_id`; name and contact move to a `retained_identity` table only compliance can read, deleted when the retention period ends.
   - Passport scans: delete once no booking needs them.
   - Mongo raw supplier payloads, S3 copies: delete, or **crypto-shred** where deletion is impractical.
   - OpenSearch: delete documents. Warehouse: facts carry pseudonymous ids only; delete the person's dimension row.
   - Logs: no personal data by policy, 30-day retention, documented.
   - Payment provider, email provider: delete via their APIs where their own retention allows. Airlines and hotels: notify them of the erasure (Art. 19); they decide on their copies as controllers.
5. **Backups:** RDS automated backups expire (max 35 days). Keep an `erasure_log` of subject ids and re-apply it after any restore.
6. **Suppression:** a table of hashed external ids (`partner_id, external_member_id`) checked by ingestion.

## Deep dives

**1. Keep vs delete in the same record set.**
Problem: the ledger must stay complete and balanced for years; the person's identity must go.
Approach: separate identity from transactions in the schema. Ledger, payments and invoices reference `subject_id`; identity lives in one table that is either deleted or moved to restricted retention. Erasure becomes "delete or restrict one row" instead of editing millions of financial rows.
Rejected: deleting payment rows (breaks balances and the law). Rejected: a `deleted_at` flag (the data is still there and still processed).

**2. Crypto-shredding: where the keys live.**
Problem: you can't edit backups or immutable archives.
Approach: encrypt per-subject blobs with a per-subject data key (envelope encryption under a KMS key); deleting the data key makes every copy unreadable. The non-obvious part: if the wrapped keys sit in the main DB, its backups still contain them. Keep them in a separate store whose backups expire quickly. Don't create one KMS key per subject; each KMS key is billed monthly.
Rejected: shredding everything. Search and analytics on encrypted fields get hard; use it for blobs and archives, plain deletion elsewhere.

**3. The twist: chargeback, upcoming trip, re-ingestion.**
Problem: an open dispute, a contract still being performed, and a partner feed that recreates the profile.
Approach: the chargeback evidence (booking, identity, payment, communications) is kept under Art. 17(3)(e), legal claims, until the dispute closes. The trip next month is a contract we still perform, so the data needed to deliver it is still necessary; we offer to cancel under the booking's terms, or keep it until the trip ends and then erase. Everything else is deleted now, and we tell the customer what is held, why, and until when. For the loyalty feed: the partner is a separate controller we can't delete from; ingestion checks the suppression table and drops the profile, and we tell the partner the link is withdrawn.
Rejected: "can't delete anything while anything is open" (over-retention) and "delete everything now" (we lose the dispute and can't deliver the trip).

## Traps

- **Soft delete as erasure**: `deleted_at` keeps the data and usually keeps processing it.
- **Deleting ledger or payment rows**: breaks double-entry and legal retention.
- **Forgetting copies**: backups, search index, warehouse, raw payloads, logs, third parties, email archives.
- **One retention number everywhere** ("7 years"): it differs by record type and country; legal owns the table.
- **Re-ingestion resurrecting deleted data** from a partner feed.
- **Calling a hashed email "anonymous"**: it's guessable and linkable; it's pseudonymous personal data.

## Say it (60–90 s)

I'd start with a registry of where personal data lives in each service and on what basis we keep it, because without that you can't promise deletion. An erasure request goes to an orchestrator that verifies the person, checks holds like an open dispute or an upcoming trip, and decides per data category: delete, restrict, or retain with a legal basis. It publishes an event, every service deletes or pseudonymizes its part idempotently and reports back with evidence, and the orchestrator tracks the one-month deadline. The financial records stay: payments, ledger and invoices are kept under the legal-obligation exception, but they reference only a subject id, and the name and contact details move to a restricted table that's deleted when retention ends. Search documents, the warehouse dimension row, raw supplier payloads, passport scans and third-party copies are deleted, and airlines and hotels are notified because they're controllers of their own copies. Logs don't hold personal data in the first place. For backups we keep an erasure log to re-apply after a restore, and crypto-shredding for archives we can't edit. A suppression list stops partner feeds from bringing the person back.

## Follow-ups

**Q:** How do you prove the deletion happened?
**A:** `erasure_tasks.evidence` per system, an audit event that references the request id (not the personal data), and the response sent to the person.

**Q:** Data in flight in SQS or Kafka?
**A:** Short retention on queues; consumers check the suppression list when they apply a message, so late messages don't recreate data.

**Q:** Analytics need history.
**A:** Facts keep pseudonymous ids and aggregates stay; the dimension row with identity is deleted, so the history can't be tied back to the person.

</details>

## Theory in the notes

- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [10-system-design/11-application-architecture.md](../../10-system-design/11-application-architecture.md)
