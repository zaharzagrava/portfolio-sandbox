# fin-15. Generating 1M monthly receipt and statement PDFs

*Fintech pack · Scaling · Medium*

## The question

On the 1st of each month we generate about 1M PDFs: a rent receipt per payment and a monthly statement per landlord, in Hebrew and English. They must be in the app and announced by email within 24 hours, and regenerating a document must never create a duplicate. Design the pipeline, including cost.

**Then:** After 300k are sent, you find the late-fee line was wrong for tenants of one PMS. What now?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Are receipts legal documents with numbering rules? → assume: yes, sequential numbers per landlord; tax rules differ by country (Israel has its own rules for receipts and tax invoices), so legal confirms what a correction must look like.
- Template: RTL, per-landlord logo, tables, page count? → assume: Hebrew RTL + English, branding per landlord, 1-3 pages.
- Data cut-off? → assume: the statement covers everything up to the period close timestamp; later items go next month.
- Email: attachment or link? → assume: link to the app; PDFs are downloaded via short-lived presigned URLs.
- Retention? → assume: 7 years as a placeholder until legal confirms.
- Deadline? → assume: 24 h hard, aim for under 6 h.

## Design

1. **Close and snapshot.** At period close, a job writes one row per document with the frozen data it will render (from the ledger, after the period is closed). Rendering never reads live tables, so a retry renders the same content.
```sql
CREATE TABLE documents (
  id uuid PRIMARY KEY, kind text NOT NULL,         -- receipt | statement
  source_id uuid NOT NULL, period date NOT NULL, revision int NOT NULL DEFAULT 1,
  template_version text NOT NULL, data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',          -- pending|rendered|failed|superseded
  s3_key text, sha256 text, attempts int DEFAULT 0,
  UNIQUE (kind, source_id, period, revision)
);
```
2. **Fan-out.** A producer pages through `pending` ids and sends SQS messages of 50 ids each (~20k messages).
3. **Workers.** ECS Fargate service, autoscaled on queue depth. Each task keeps a warm headless Chromium (Puppeteer) and renders HTML templates; Chromium handles RTL, Hebrew shaping and fonts correctly. Warm render ≈ 0.3-1 s per document; 1M × 0.5 s ≈ 140 render-hours → 50 parallel renderers finish in ~3 h. Recycle the browser every few hundred documents to cap memory growth.
4. **Upload.** Deterministic key `docs/{kind}/{period}/{id}-r{revision}.pdf`. A retry overwrites the same object. Then `UPDATE documents SET status='rendered', s3_key=$2, sha256=$3 WHERE id=$1 AND status='pending'`.
5. **Retries.** Visibility timeout > batch time; `maxReceiveCount` 5 → DLQ. A redelivered batch skips ids already `rendered`.
6. **Notify.** After render, an outbox job sends one email per recipient (dedupe key = document id) with an app link.
7. **Cost** (us-east-1 list prices, approximate): 1M S3 PUTs ≈ $5; storage 1M × ~80 KB ≈ 80 GB ≈ $2/month, growing each month; Fargate ≈ 70 task-hours of 2 vCPU/4 GB ≈ under $10. Email is the largest line item. Keep receipts in S3 Standard: Standard-IA and Glacier Instant Retrieval bill objects under 128 KB as 128 KB, so small PDFs can cost more there.
8. **Done check.** Dashboard of counts by status per period; alert if anything is `pending` or `failed` at T+6 h.

## Deep dives

**1. Snapshot vs rendering from live data.**
Problem: payments, refunds and late returns keep changing live tables; a retry hours later would render different numbers than the first attempt, and you can't prove what was issued.
Approach: freeze `data` at close; render is a pure function of `(data, template_version)`; store `sha256` of the result.
Rejected: render on demand when the user clicks download. Spiky load, nothing ready to email, and no fixed issued version.

**2. Correcting issued documents (the twist).**
Problem: 300k sent; some wrong. Issued receipts are legal records.
Approach: stop the pipeline for that PMS (kill switch on the producer); fix the rule and the underlying ledger entries (that's the ledger's job, not the PDF's); select affected documents by PMS and period; create `revision = 2` rows with the corrected snapshot; render; mark revision 1 `superseded` but keep it; notify only affected recipients with "corrected statement". If local tax rules require a correction document instead of a replacement, issue that.
Rejected: overwriting the S3 object. It destroys the record of what was sent.

**3. Chromium on Fargate vs Lambda vs a PDF library.**
Problem: throughput, RTL correctness, cost.
Approach: Fargate with warm browsers: predictable throughput, controlled DB/S3 concurrency.
Rejected (but viable): Lambda. Compute cost is similar (1M × 1 s × 2 GB ≈ $35), but cold starts load Chromium each time and you tune reserved concurrency instead of tasks. Rejected: low-level PDF libraries; fast (tens of ms) but bidi text and Hebrew layout become our problem.

## Traps

- **One cron loop in one process** generating 1M files: hours, no retry granularity, dies on deploy.
- **Rendering from live tables**: retries produce different PDFs.
- **Random S3 keys** (`uuid()` per attempt): duplicates on every retry.
- **Attaching PDFs to 1M emails**: size limits, deliverability, personal financial data sitting in mailboxes.
- **Overwriting an issued document** after a bug.
- **Lifecycle rule to Standard-IA for small PDFs**: the 128 KB minimum billable size can make it more expensive.

## Say it (60–90 s)

I split it into close, render and notify. At period close a job writes one documents row per receipt and statement with a frozen snapshot of the data from the ledger, so rendering never touches live tables and a retry always produces the same content. A producer sends SQS messages of fifty document ids. Workers on Fargate keep a warm headless Chromium, render the HTML template, which handles Hebrew right-to-left properly, and upload to a deterministic S3 key per document and revision, so a retry overwrites instead of duplicating. Then a guarded update marks the row rendered with the S3 key and a hash. Failed batches retry through SQS and go to a DLQ after five attempts. With fifty parallel renderers at about half a second each, a million documents take around three hours, and compute plus S3 cost tens of dollars; email is the bigger cost. Notifications are a separate outbox step with the document id as dedupe key, and they contain a link, not an attachment. If a batch turns out wrong, I stop that cohort, fix the data, render revision two, keep revision one as superseded, and notify only the affected people.

## Follow-ups

**Q:** How does a tenant download the PDF?
**A:** API checks ownership, returns a presigned GET valid for a few minutes. The bucket is private, SSE-KMS encrypted, and has no public access.

**Q:** Doesn't the snapshot step hammer the primary DB?
**A:** It reads closed, immutable periods, so a replica is fine once it has replayed past the close; keyset pagination, a few thousand rows per query.

**Q:** How do you know nothing is missing?
**A:** Expected count = payments + landlords for the period; compare with rendered count; alert on `pending`/`failed` and DLQ depth.

</details>

## Theory in the notes

- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
- [02-nodejs/03-memory-and-performance.md](../../02-nodejs/03-memory-and-performance.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
