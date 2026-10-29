# arch-07. Search autocomplete for an online store

*Search · Easy*

## The question

"Design search autocomplete for an online store with 5M products and ~20M searches a day. As the user types in the search box, show up to 8 suggestions (past popular queries plus matching categories) within 100 ms end to end, in English and Spanish."

**Then:** "Marketing launches a new product line at 9:00 and wants it to show in suggestions within 5 minutes. And an offensive query starts trending because of a coordinated prank."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Suggest queries or products? → assume: queries ("running shoes women") plus category shortcuts; product hits are the search page's job.
- Personalized? → assume: the user's recent searches first (from the client), then global popular queries. No server-side per-user model.
- Typo tolerance? → assume: yes from 4+ typed characters (`snekers` → `sneakers`).
- Freshness? → assume: hourly rebuild normally; the twist adds minutes.
- Numbers → assume: 20M searches/day, ~6 keystroke requests each after a 100-150 ms client debounce → ~120M requests/day ≈ 1.4k/s avg, ~7k/s peak. Latency: 100 ms end to end leaves ~20 ms server p99 after network.
- Data size → assume: ~2M distinct queries worth keeping (count ≥ 5 in 30 days); prefixes up to 20 chars ≈ 20M prefix entries × top 8 suggestions (IDs ~4 B each + score) ≈ 1-2 GB in memory per locale.

## Design

**1. Offline build (hourly).**
- Search logs (S3, via Firehose) → a job aggregates queries by normalized form (lowercase, trimmed, Unicode-normalized, accents folded for matching but kept for display) with exponential time decay (half-life ~7 days), last 30 days.
- Filters: minimum count, blocklist (profanity, slurs), drop queries that look like emails, phone numbers or order numbers (users paste PII into search boxes), drop queries with zero results.
- Add category names with a boost.
- Build a sorted array of queries plus a prefix map `prefix → top 8 query IDs by score` (or an FST). Serialize to S3 as one versioned file per locale.

**2. Serving.** A stateless Node service loads the file into memory at startup and when a new version appears (poll S3 every minute, atomic swap of the in-memory reference). `GET /suggest?q=run&locale=en`: normalize → lookup → return strings. No database on the request path. Typo tolerance for ≥ 4 chars: if the exact prefix has < 8 results, try candidates within edit distance 1 from a precomputed deletion index (SymSpell-style).

**3. Caching.** Prefixes of 1-2 characters are a large share of traffic and identical for everyone: `Cache-Control: public, max-age=300` and CloudFront caching keyed by `q` + locale. Longer prefixes go to the service.

**4. Client.** Debounce 100-150 ms, cancel the previous request with `AbortController`, and drop responses whose query no longer matches the input (out-of-order responses). Merge the user's recent searches (local storage) on top.

**5. Hot overlay (freshness).** A small stream job counts queries per minute from the click/search stream; queries with a sharp rise go into a "hot" list (top few thousand), pushed to servers every minute and merged with the hourly index at lookup time, both after the blocklist.

**6. Metrics:** p99 latency, suggestion click-through rate, zero-suggestion rate per prefix length, index age.

## Deep dives

**1. Where the index lives.** Options: OpenSearch completion suggester (`completion` field, in-memory FST per shard), Redis sorted sets per prefix (`ZREVRANGE ac:run 0 7`), or an in-process index built offline. Chosen: in-process, because the data is a few GB per locale, read-only between builds, and lookups are microseconds with no network hop. Rejected for now: Redis per prefix (20M keys and a network round trip for no benefit); OpenSearch is a fine choice if the store already runs it and wants unified fuzzy matching.

**2. Freshness for the launch (twist, part 1).** The hourly build can't meet 5 minutes. Chosen: marketing adds "pinned" suggestions (product line name, start/end time, locales) in an admin tool; servers fetch pins every minute and merge them at a high score. Real user queries for the new line then flow through the hot overlay within minutes. Rejected: rebuilding the full index every minute.

**3. Abuse (twist, part 2).** Popularity is an input users control. Chosen: the blocklist applies to both the hourly index and the hot overlay; the hot overlay counts distinct users (or sessions) rather than requests and caps per-IP contribution, so a few bots can't push a query; a kill-list update from the admin propagates in one minute, and the CDN cache for affected short prefixes is invalidated. Rejected: counting raw request volume.

## Traps

- Querying Postgres `LIKE 'run%'` on every keystroke: works at small scale, then becomes the busiest query in the system for the least important feature.
- No client debounce or cancellation: 3x the traffic, and late responses overwrite newer ones.
- Ranking by all-time counts: last winter's queries outrank this week's trends. Use time decay.
- Suggesting raw logged queries without filtering: users type emails, phone numbers and offensive text into search boxes.
- Counting requests instead of distinct users for trends: trivially gamed.
- Rebuilding a mutable shared index in place: readers see a half-built state. Build a new version and swap.

## Say it (60–90 s)

Suggestions come from what people searched before, so I build the index offline. Every hour a job aggregates the last thirty days of search logs with time decay, normalizes the queries, drops anything with too few searches, zero results, blocklisted words or things that look like emails and phone numbers, adds category names, and writes a prefix-to-top-eight map per locale to S3. That's one to two gigabytes, so each autocomplete server holds it in memory and swaps in new versions atomically; a lookup is microseconds and there's no database on the path. Typo tolerance kicks in from four characters using a precomputed deletion index. One- and two-letter prefixes are the same for everyone, so CloudFront caches them for five minutes. The client debounces, cancels stale requests and ignores out-of-order responses. For freshness, a stream job finds queries that are spiking and pushes a small hot list every minute, and marketing can pin a suggestion for a launch so it shows within a minute. Trends count distinct users, not requests, and the blocklist applies to everything, so a prank can't push an offensive query.

## Follow-ups

**Q:** How would you add personalization beyond recent searches?
**A:** Re-rank the top ~30 candidates per prefix with user features (gender/category affinity from purchase history) in the service; the prefix index stays global. Measure with an A/B test on click-through and search conversion.

**Q:** What about languages without spaces or with many inflections?
**A:** Language-specific normalization and tokenization per locale; for Spanish, accent folding (`cafe` matches `café`) is the main thing.

**Q:** How do you roll out a bad index safely?
**A:** Each build is versioned; servers validate it (size, sample lookups) before swapping; canary one server; keep the previous version to roll back.

</details>

## Theory in the notes

- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [10-system-design/04-web-platform-architectures.md](../../10-system-design/04-web-platform-architectures.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [01-javascript-typescript/04-fetch-axios-async.md](../../01-javascript-typescript/04-fetch-axios-async.md)
