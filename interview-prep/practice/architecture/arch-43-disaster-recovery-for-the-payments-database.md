# arch-43. Disaster recovery for the payments database

*Reliability · Hard*

## The question

"The payments database is Postgres on AWS: ~800 GB, ~1,500 writes/s at peak, one region. The CTO asks: what are our RPO and RTO today, what should they be, and what happens if (a) the primary instance dies, (b) an Availability Zone goes down, (c) a bad migration deletes data, (d) the whole region is unavailable for hours?"

**Then:** "After a regional failover you lost the last 3 seconds of writes. Some of them were card payments the PSP had already charged. How do you recover?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- What runs today? → assume: RDS for PostgreSQL, Multi-AZ with one standby, automated backups with 7-day retention.
- Business targets? → assume: RPO 0 and RTO < 5 min for instance/AZ failures; for region loss RPO ≤ 1 min, RTO ≤ 1 h.
- Data residency? → assume: the secondary region must satisfy the same residency rules (check before picking one).
- Is the rest of the stack multi-region? → assume: no. A database in region B is useless without app, secrets, queues and DNS there.
- Budget? → assume: a warm secondary region roughly doubles DB cost; acceptable for payments.
- Who decides a regional failover? → assume: a named on-call human, following a runbook.

## Design

**Answer per scenario (today's setup and the target).**
| Scenario | Mechanism | RPO | RTO |
|---|---|---|---|
| (a) instance dies | RDS Multi-AZ, one standby: synchronous replication, DNS flips to standby | 0 | typically 1-2 min |
| | Multi-AZ DB cluster (two readable standbys) | 0 (commit waits for one standby) | typically < 35 s |
| | Aurora with a replica: 6 storage copies across 3 AZs, promote replica | 0 | typically ≤ ~30 s |
| (b) AZ down | same as (a): the standby/replica is in another AZ | 0 | same |
| (c) bad migration / bad DELETE | replication copies it instantly; only **PITR** helps: restore a new instance to just before the event | down to the second chosen | restore time: tens of minutes to hours for 800 GB |
| (d) region down | Aurora Global Database (async storage-level replication) | typically seconds (= lag) | typically minutes, plus app failover |
| | RDS cross-region read replica, promote manually | = replica lag | minutes + app |
| | cross-region backup copies only | hours (copy frequency) | hours (restore) |
| (e) account compromise / ransomware | AWS Backup copies to a separate account, vault lock | last copy | hours |

**Target design:** Aurora PostgreSQL, writer + 2 replicas across AZs (RDS Proxy in front to shorten reconnects), Aurora Global Database to a second region, automated backups at 35 days (the maximum), AWS Backup copies to an isolated account. The second region has the app deployed from the same IaC at minimal size, Secrets Manager replica secrets, multi-Region KMS keys, S3 replication, and a runbook for DNS and webhook endpoints.

**Bad-data recovery (c):** restore to a new cluster at T-1 min, copy the damaged rows from the restored copy back into production with a script, keep all writes made after T. Never swap the whole database back: you'd lose every legitimate payment since T. Note: on RDS a restored instance loads blocks from S3 lazily, so it's slow at first.

**Drills:** monthly automated PITR restore with timing recorded; quarterly AZ failover in production at low traffic; yearly planned regional switchover (RPO 0 for Aurora Global Database switchover).

## Deep dives

**1. High availability is not backup.** Multi-AZ and replicas protect against hardware and AZ loss; they replicate a `DELETE` in milliseconds. (c) needs PITR, and the real RTO for (c) is restore time plus repair time, so measure it monthly instead of assuming. Aurora Backtrack, which rewinds in place, exists only for Aurora MySQL, not PostgreSQL. PITR's newest restorable point lags (RDS ships transaction logs to S3 every 5 minutes; Aurora documents the latest restorable time as up to 5 minutes in the past), which matters only for total loss, not for (c).

**2. Regional failover is a human decision.** Unplanned Aurora global failover loses whatever hadn't replicated (typically seconds), and AWS documents that fencing writes on the old primary is best-effort, so split-brain is possible if the old region comes back accepting writes. Chosen: manual trigger by on-call with a runbook, after confirming the region is really down. Rejected: automatic cross-region failover on health checks; a flaky check would cause data loss and a split brain to fix a 2-minute blip.

**3. The database is the easy part.** Region B also needs: services, secrets, queues, the PSP webhook URL (registered per environment at the PSP), DNS, KMS keys that can decrypt replicated data, and capacity. Rehearse the full path, not just `failover-global-cluster`.

## Traps

- "Multi-AZ is our backup": it replicates the bad delete too.
- Stating RPO 0 for cross-region async replication.
- Restoring the whole database to before a bad migration and discarding hours of real payments.
- Never testing restores: the first real restore discovers missing grants, parameter groups and a 4-hour restore time.
- A DR plan that covers the database but not the app, secrets, DNS and webhooks.
- Automatic regional failover on a single health check.

## Say it (60–90 s)

I'd answer per failure, because RPO and RTO differ for each. If the primary instance or a whole AZ dies, Multi-AZ covers it: replication to the standby is synchronous, so RPO is zero, and failover is typically one to two minutes on classic Multi-AZ, under 35 seconds on a Multi-AZ cluster, or around 30 seconds on Aurora with a replica. A bad migration is different: replication copies the delete instantly, so only point-in-time recovery helps. I restore a new instance to just before the mistake, copy the damaged rows back, and keep everything written since. For 800 gigabytes that takes tens of minutes to hours, so I measure it in a monthly restore drill. For losing a region, I'd use Aurora Global Database: replication is asynchronous, so RPO is typically seconds and RTO minutes, plus moving the app. The failover is a human decision with a runbook, because AWS describes write fencing in the old region as best-effort. The second region needs the app, secrets, keys and webhook endpoints ready too. For account compromise, AWS Backup copies to a separate locked account. And whatever we lose in a regional failover, we recover from the PSP, because it's the other record of every payment.

## Follow-ups

**Q:** Then: 3 seconds lost, but the PSP charged those cards. How do you recover?
**A:** The PSP is the second record. Pull its charges and events from T-5 min onward, match them on our payment ID in metadata, and re-create missing payments and ledger entries with a recovery job. PSPs retry undelivered webhooks and offer an events API, so webhook handlers that can create a missing payment from the event help here. Client retries are safe because our PSP idempotency key is derived from our payment ID, and the PSP keeps it for its own window (Stripe: at least 24 h). Also check downstream: notifications may have been sent for payments we then lost; reconciliation finds those too.

**Q:** Why not active-active multi-region Postgres?
**A:** Postgres has one writer. Multi-writer means conflict resolution on balances, which a ledger can't accept, and the complexity is far beyond these targets.

**Q:** 7-year retention for financial records?
**A:** That's archiving, not DR: automated backups go to 35 days max; long retention is exports to S3 with Object Lock or long-lived snapshots.

</details>

## Theory in the notes

- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
- [07-observability-reliability/01-sli-slo-error-budgets-alerting-runbooks.md](../../07-observability-reliability/01-sli-slo-error-budgets-alerting-runbooks.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
