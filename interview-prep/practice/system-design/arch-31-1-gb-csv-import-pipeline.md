# arch-31. 1 GB CSV import pipeline

*Data · Medium*

## The question

"Customers moving to our CRM upload CSV exports of contacts and deals from their old system: up to 1 GB, ~4M rows. We validate each row, upsert into Postgres, and show a report of what failed. Uploads must survive flaky connections, and API servers must not hold the file in memory. Design it."

**Then:** "An import fails at row 3.2M after 20 minutes. Also, the customer uploads the same file twice."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Format? → assume: our template, but files come out of Excel and old CRMs: BOM, `,` or `;` delimiters, quoted newlines, and encodings other than UTF-8 (Windows-1252, UTF-16 from Excel's "Unicode Text", Shift_JIS from Japanese customers).
- Partial success? → assume: validate everything first, show the report, the customer chooses "import valid rows" or "fix and re-upload".
- Upsert key? → assume: `(org_id, external_id)` from their old system.
- Time target? → assume: 1 GB end-to-end in under 30 min.
- Personal data? → assume: names, emails, phones: encrypted bucket, raw file deleted after 30 days.
- Concurrency? → assume: one active import per org.

## Design

1. **Upload direct to S3, multipart.** `POST /imports` creates an `imports` row and an S3 multipart upload, and returns presigned URLs for the parts (e.g. 100 × 10 MB). The browser uploads parts in parallel and retries only failed parts; `POST /imports/:id/complete` sends the ETags → `CompleteMultipartUpload`. Limits: parts 5 MiB-5 GiB (the last can be smaller), up to 10,000 parts. A bucket lifecycle rule aborts incomplete multipart uploads after 1 day; otherwise orphan parts are billed indefinitely.
2. **Kick off.** The complete call enqueues an import job; the worker runs on ECS (an import can exceed Lambda's 15-minute limit).
3. **Validate phase (streaming).** `GetObject` body → encoding detection (BOM, then a heuristic; `iconv-lite` to UTF-8) → `csv-parse` stream with `max_record_size` → row validation (zod) → batches of 5,000 → `COPY` into a staging table via `pg-copy-streams`. `stream/promises.pipeline` handles backpressure, so memory stays flat whatever the file size.
```sql
CREATE TABLE import_rows (
  import_id uuid, row_no int, external_id text,
  data jsonb, valid boolean, errors jsonb,
  PRIMARY KEY (import_id, row_no));
```
Cross-row checks run in SQL after the load (duplicate `external_id` in the file: `GROUP BY ... HAVING count(*) > 1`; deals pointing at contacts missing from both the file and the DB).
4. **Report.** Counts in the UI; an error CSV (row, column, masked value, message) via presigned URL. Cells starting with `=`, `+`, `-`, `@` are prefixed with `'` so Excel doesn't run them as formulas.
5. **Commit phase.** After the customer confirms: set-based upserts from staging in chunks of 10k rows, each its own transaction: `INSERT INTO contacts (...) SELECT ... FROM import_rows WHERE import_id = $1 AND valid AND row_no BETWEEN $2 AND $3 ON CONFLICT (org_id, external_id) DO UPDATE SET ... WHERE (contacts.email, contacts.name, ...) IS DISTINCT FROM (excluded.email, excluded.name, ...)`. After each chunk, `imports.committed_through = $3`. Contacts commit before deals.
6. **Progress.** `imports.status`, `rows_parsed`, `committed_through`; the UI polls.
7. **Cleanup.** Staging partitioned by day and dropped after 7 days; raw file deleted by lifecycle after 30 days.

## Deep dives

**1. Staging + COPY vs row-by-row.**
Problem: 4M individual inserts with network round trips run at a few thousand rows/s: tens of minutes, plus row-level error handling in Node.
Approach: `COPY` into staging is the fastest load path in Postgres (4M narrow rows in a minute or two); validation results live next to the data; the merge is set-based SQL in bounded chunks.
Rejected: parsing the whole file into memory first. 1 GB of CSV becomes several GB of JS objects and the pod dies.

**2. Resume at row 3.2M (twist, part 1).**
Problem: 20 minutes lost if you restart from zero.
Approach: the validate phase is idempotent by `(import_id, row_no)`; on restart, read `max(row_no)`, re-stream the file and skip rows up to it (parsing is cheap; the DB work was the expensive part). The commit phase resumes from `committed_through`; upserts make a repeated chunk harmless.
Rejected: one transaction for the whole import. Locks and WAL for 20+ minutes, then a full rollback at row 3.2M.

**3. Same file twice (twist, part 2).**
Problem: duplicate uploads, double clicks.
Approach: the worker computes SHA-256 while streaming; if `(org_id, sha256)` matches a recent import, the UI says "identical to import #123 from yesterday" and asks for confirmation. Even if confirmed, upserts by external id with the `IS DISTINCT FROM` guard leave the data unchanged and write no new row versions.
Rejected: deduping by file name. Every export is called `export.csv`.

## Traps

- **Uploading through the API server** (in-memory multipart parsing): 1 GB in the heap, load balancer timeouts, no resume.
- **Splitting on newlines**: quoted fields contain newlines.
- **Assuming UTF-8**: Excel and older CRMs often export in a legacy code page or UTF-16.
- **Lambda for a 20+ minute job**: 15-minute hard limit.
- **An error report CSV without escaping**: formula injection when the customer opens it in Excel.
- **One transaction for 4M rows.**

## Say it (60–90 s)

The file never passes through our API servers. The browser does an S3 multipart upload with presigned part URLs, so a flaky connection only retries the failed part, and a lifecycle rule cleans up abandoned uploads. When the upload completes, a worker on ECS, not Lambda because of the fifteen-minute limit, streams the object from S3: it detects the encoding, because Excel exports are often not UTF-8, parses with a streaming CSV parser, validates each row, and COPYs batches of five thousand into a staging table with the row number, a valid flag and the errors. The stream pipeline handles backpressure, so memory stays flat. Cross-row checks like duplicate ids run in SQL on staging. The customer sees counts and a downloadable error report, escaped against formula injection, and decides whether to import the valid rows. The commit is set-based upserts from staging in chunks of ten thousand, each its own transaction, with a checkpoint after each chunk. If it fails at row 3.2 million, both phases resume from their checkpoints. A file hash detects the same file uploaded twice, and the upserts make a repeat harmless anyway.

## Follow-ups

**Q:** How do you protect live traffic while committing 4M rows?
**A:** Small chunks with short transactions, a dedicated pool of 1-2 connections, pauses between chunks, and throttling on replica lag.

**Q:** What if one row is 500 MB?
**A:** `max_record_size` in the parser rejects it, and the import fails with a clear message instead of an OOM.

**Q:** Do you virus-scan CSVs?
**A:** Parsing is the validation. We reject non-text content early (magic bytes of zip, PDF, executables), and never serve the raw upload to other users.

</details>

## Theory in the notes

- [02-nodejs/02-streams-and-backpressure.md](../../02-nodejs/02-streams-and-backpressure.md)
- [08-devops-cloud/03-aws-for-nodejs-engineers.md](../../08-devops-cloud/03-aws-for-nodejs-engineers.md)
- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
- [05-security/01-web-security-xss-csrf-csp.md](../../05-security/01-web-security-xss-csrf-csp.md)
