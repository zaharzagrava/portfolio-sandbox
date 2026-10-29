# arch-18. Ad click aggregation and top-K trending ads

*Streaming · Hard*

## The question

"Our ad network serves ads in partner apps and websites. We get ~1B ad clicks a day, peaks of 50k/s. Advertisers need click counts per ad per minute on their dashboards within a minute, billing needs exact daily counts, and the sales team wants a live 'top 100 most-clicked ads in the last 5 minutes' per country. Design the pipeline."

**Then:** "The stream job crashes and restarts from a 10-minute-old checkpoint. And an advertiser disputes their invoice: our click count is 3% higher than their own analytics."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- What is a billable click? → assume: a unique `click_id` (generated when the click redirect is served), deduplicated within 10 minutes, not flagged by fraud filters.
- How late can events arrive? → assume: most within seconds; mobile SDKs buffer offline and can send hours late. Clicks later than 24 h are not billed.
- Freshness → assume: dashboards ≤ 1 min behind; top-K updated every 10 s; billing next morning.
- Retention → assume: raw clicks 1 year in S3 for audits and disputes; minute aggregates 2 years.
- Numbers → assume: 1B/day ≈ 11.6k/s avg, 50k/s peak; ~200 B per event → ~200 GB/day raw, ~10 MB/s at peak. ~2M active ads; minute aggregates only exist for ads clicked in that minute (≤ clicks/min, typically far fewer rows).
- Budget pacing? → assume: advertisers' daily budgets are enforced from the streaming counts (fast, slightly approximate), reconciled by billing.

## Design

**1. Collect.** The click redirect service (ad click → advertiser URL) writes `{click_id, ad_id, campaign_id, ts_event, country, device, ip_hash, ua_hash}` to Kafka `clicks` (partitioned by `click_id` hash for even spread, RF 3, 7-day retention). Firehose/Kafka Connect copies the raw topic to S3 (Parquet, partitioned by hour).

**2. Stream job** (Flink, event time):
1. Dedupe: `keyBy(click_id)` with state TTL 10 min; drop repeats.
2. Watermark = max event time − 2 min. Tumbling 1-minute windows `keyBy(ad_id)`, count by (country, device). Allowed lateness 10 min: late events re-fire the window with the **updated full count**. Later than that → side output topic `late_clicks`.
3. Hot ads: pre-aggregate per subtask before the `keyBy(ad_id)` shuffle (local combine), so one viral ad doesn't overload one subtask.
4. Sink window results to ClickHouse `ad_clicks_minute(ad_id, minute, country, device, clicks, version)` as a `ReplacingMergeTree(version)`: a re-fired or replayed window writes the same key and the latest version wins.
5. Top-K: from the per-minute counts, a 5-minute sliding window (slide 10 s) per country: each subtask keeps its local top 100 by count; a final single-parallelism operator merges them into the global top 100 → Redis `topk:{country}` for the sales dashboard.

**3. Billing (batch, daily).** Over raw S3 events for the day (in the advertiser's billing time zone): dedupe by `click_id` across the whole day, apply fraud filter results, count per ad/campaign. Writes `billing_clicks(day, campaign_id, clicks)` to Postgres. This, not the stream, feeds invoices.

**4. Reconcile.** Daily: stream totals vs batch totals per campaign; a difference above 0.5% alerts (usually a bug or a fraud-filter change).

**5. Fraud filter.** A separate stream job scores clicks (IP/device rates, data-center IPs, click timing) and emits `click_id` flags; billing excludes flagged clicks; dashboards show them separately.

## Deep dives

**1. Restart from an old checkpoint (twist, part 1).** Flink restores operator state (dedupe set, window counts) and Kafka offsets from the same checkpoint, so internally every event is counted once. The risk is the sink: windows emitted after that checkpoint are emitted again. Chosen: windows emit absolute counts with a deterministic key `(ad_id, minute, country, device)`, and ClickHouse keeps the latest version, so a replay overwrites with the same number. Rejected: emitting increments (`+37`) to a summing table, which double-counts on every replay; Kafka-transactional exactly-once sinks are the alternative when the next hop is Kafka, at the cost of consumers reading `read_committed` with checkpoint-interval latency.

**2. Exactness for billing.** Streaming with watermarks trades completeness for latency: events after the allowed lateness are not in the minute counts. Chosen: two paths. The stream serves dashboards, pacing and top-K; a daily batch over immutable raw events is the billing record. Rejected: billing from the stream (late mobile events missing, and any streaming bug becomes a money bug with no recomputation).

**3. The 3% dispute (twist, part 2).** Our click is the redirect; their analytics count landing-page sessions. Users who bounce before their page's script runs, ad blockers and consent banners that block their analytics, and different day boundaries (UTC vs their time zone) all make their number lower. Chosen: give advertisers a click-level export (click IDs, timestamps) and pass the click ID to the landing URL so they can match row by row; check our side for dedupe-window or fraud-filter changes that day. Rejected: crediting 3% to make it go away.

**4. Top-K exact vs approximate.** 2M ads per window fit in memory (2M × ~50 B = 100 MB), so exact counts are affordable; count-min sketch + heap only pays off with hundreds of millions of keys. Chosen: exact local top-K per subtask, merged globally.

## Traps

- Counting by processing time: a backlog after an outage puts yesterday's clicks into today's minutes.
- Sinks that add increments: every replay or restart double-counts.
- Billing from the real-time stream: late events and stream bugs become invoice errors with no way to recompute.
- Partitioning raw events by `ad_id`: a viral ad overloads one partition and one consumer.
- No dedupe by click ID: double-clicks and SDK retries inflate advertisers' bills.
- Using count-min sketch where exact counting fits in memory, then explaining approximate numbers to sales.

## Say it (60–90 s)

Every click goes through our redirect, which writes an event with a unique click ID and the event time to Kafka, and the raw topic is copied to S3 as the permanent record. A Flink job working in event time deduplicates by click ID, counts per ad per minute with a two-minute watermark and ten minutes of allowed lateness, and pre-aggregates locally so a viral ad doesn't overload one task. Window results go to ClickHouse as absolute counts keyed by ad, minute, country and device, so a replay overwrites rather than adds. That's why restarting from a ten-minute-old checkpoint is safe: state and Kafka offsets roll back together, and the re-emitted windows carry the same numbers. Top-K is a five-minute sliding window: each task keeps a local top hundred and one operator merges them into Redis for the sales dashboard. Two million ads fit in memory, so counts are exact. Billing doesn't use the stream: a daily batch job over the raw events dedupes across the day, applies fraud flags and writes invoice counts, and I reconcile it against the stream. For the dispute, they count landing-page sessions and we count clicks, so I give them a click-level export to match by click ID.

## Follow-ups

**Q:** Kafka is down for 5 minutes. What happens to clicks?
**A:** The redirect service must still redirect: it buffers events locally (bounded memory + disk) and retries; the redirect never waits on Kafka. Events arrive late, and event-time windows put them in the right minute within allowed lateness, or the batch catches them.

**Q:** Why ClickHouse and not Postgres for minute aggregates?
**A:** Hundreds of millions of rows per day, queried by ad and time range with aggregations; a columnar store compresses and scans this cheaply. Postgres keeps the daily billing results.

**Q:** How do you test the stream job?
**A:** Flink's test harnesses with controlled watermarks for late and out-of-order events; a replay of a recorded hour compared against the batch result for the same hour.

</details>

## Theory in the notes

- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [10-system-design/02-worked-examples.md](../../10-system-design/02-worked-examples.md)
