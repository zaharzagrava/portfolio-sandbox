# arch-33. Search with filters: Postgres indexes vs OpenSearch

*Data · Medium*

## The question

Landlords and our support team search residents and payments by name (partial, Hebrew and English), phone, email, unit, status, date range and amount range, sorted and paginated. 30M payments and 3M residents, growing 1M payments a month; p95 must be under 300 ms. Postgres indexes or OpenSearch? Design it.

**Then:** Support complains that a payment that succeeded 2 seconds ago still shows "pending" in search results.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Who searches what? → assume: landlords search only their own org; support searches across all orgs.
- Fuzzy matching (typos, transliteration "Cohen"/"Kohen"/"כהן")? → assume: landlords need prefix/substring; support wants typo tolerance.
- Facet counts ("142 failed, 30 pending")? → assume: nice to have.
- Freshness? → assume: landlord search must reflect changes within seconds.
- Largest org? → assume: ~2M payments.
- Exact total counts required? → assume: no; "1,000+" is fine past a threshold.

## Design

**Landlord search: Postgres.** Every query is scoped to one org, which is selective.
```sql
CREATE INDEX pay_org_status_date ON payments (org_id, status, created_at DESC, id DESC);
CREATE INDEX pay_org_date        ON payments (org_id, created_at DESC, id DESC);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX res_name_trgm ON residents USING gin (name_search gin_trgm_ops);
CREATE INDEX res_org_phone ON residents (org_id, phone_e164);
CREATE INDEX res_org_email ON residents (org_id, email_lower);
```
1. **Normalize on write:** phone to E.164, email lowercased, `name_search` = Hebrew + Latin name lowercased, niqqud and punctuation stripped.
2. **Whitelisted filters and sorts.** Each allowed sort has a matching index; unsupported combinations are rejected instead of becoming sequential scans.
3. **Keyset pagination:** `WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 50`.
4. **Counts:** exact up to 1,000 (`LIMIT 1001` in a count subquery), else "1,000+".
5. **Minimum 3 characters** for substring search: trigram indexes give little or no help below that.

**Support search: OpenSearch** (cross-org, typo-tolerant, any field).
6. Index `payments_v3` (alias `payments`) with denormalized documents: payment + resident name + unit + org name.
7. **Sync:** status change → outbox row → SQS → indexer reads the **current** row from Postgres and indexes it with `version_type=external`, `version` = the row's monotonic `version` column. Out-of-order or duplicate messages with a lower version are rejected by OpenSearch.
8. **Reindex:** build `payments_v4` from a Postgres backfill while the indexer writes to both, then swap the alias.
9. **Results are ids.** Rows are hydrated from Postgres (by primary key) before display, so the status shown comes from the source of truth.
10. **Monitoring:** indexer lag (now − event time), document count vs Postgres count per day.

## Deep dives

**1. When Postgres stops being enough.**
Problem: avoid a second datastore until it pays for itself.
Approach: Postgres while queries are org-scoped and the filters map to a few composite indexes. Move to OpenSearch when you need relevance ranking, typo tolerance, free text across many fields, facet counts over millions of rows, or arbitrary sort/filter combinations. Cost: a cluster, a sync pipeline, reindexing, and eventual consistency.
Rejected: OpenSearch for everything on day one: landlord queries are cheap in Postgres, and every extra store is another copy to secure, sync and erase.

**2. Hebrew.**
Problem: Postgres full-text search ships no Hebrew stemmer.
Approach: trigrams on a normalized name column. Check the database locale: pg_trgm decides what counts as a word character based on `LC_CTYPE`, and with the `C` locale non-ASCII letters may be ignored. Test with Hebrew data before relying on it. In OpenSearch use the ICU analysis plugin for normalization; morphological Hebrew analysis needs third-party plugins, and for names n-grams usually suffice.

**3. Stale status in search (twist).**
Problem: indexer lag (queue + default 1 s refresh interval) shows "pending" after success.
Approach: never render status from the index; hydrate from Postgres by id. When the user filters by status, the index may include or miss a just-changed row; re-check the filter after hydration and drop mismatches. For support actions that change a payment, index with `refresh=wait_for` so the next search sees it.
Rejected: dual-writing Postgres and OpenSearch in the request. A failure between the two writes leaves them permanently different, and nothing repairs it.

## Traps

- **`ILIKE '%x%'` without a trigram index**, or with 1-2 character patterns.
- **OFFSET pagination** deep into results: cost grows with the offset.
- **`COUNT(*)` on every search** over millions of rows.
- **Dual writes** to Postgres and the search index from request code.
- **Showing money status from the index** as truth.
- **Personal data in the index without access control and deletion**: erasure requests must reach it.

## Say it (60–90 s)

I'd split by who's searching. Landlords only search their own org, which is selective, so Postgres handles it: composite indexes starting with org id, then the equality filter, then the sort column; a trigram GIN index on a normalized name column for partial Hebrew and English matches; phone and email normalized on write so exact lookups hit B-tree indexes. Only whitelisted filter and sort combinations are allowed, each backed by an index. Pagination is keyset, and counts are capped at a thousand. Support searches across all orgs and wants typo tolerance, which is where OpenSearch earns its place. I'd index denormalized payment documents through the outbox, SQS and an indexer that reads the current row from Postgres and writes with external versioning, so late or duplicate messages can't overwrite newer data. Reindexing builds a new index and swaps an alias. Search returns ids, and I hydrate rows from Postgres before showing them, so the status on screen is always the real one; that also fixes the two-second-old pending result. I'd monitor indexer lag and compare document counts with Postgres daily.

## Follow-ups

**Q:** How do you choose the column order in a composite index?
**A:** Equality columns first (`org_id`, `status`), then the range or sort column (`created_at`), then a tiebreaker (`id`) for keyset pagination.

**Q:** Users combine filters in many ways. Index every combination?
**A:** No. A few composite indexes for the common paths; Postgres can combine single-column indexes with bitmap AND for rare ones. Watch `pg_stat_statements` for slow shapes.

**Q:** How do you know the index is complete?
**A:** Daily count comparison per org and day bucket; re-index any bucket that differs.

</details>

## Theory in the notes

- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
