# arch-51. E-commerce read paths: one source of truth, five read models

*Data · Medium*

## The question

"We run an online shop: ~200k products, ~2M visitors a day, ~20k orders a day, all in one Postgres today. Product pages are slow at peak, search is a `LIKE '%…%'` query that times out, the sales dashboard query locks up the database at month end, and finance exports to spreadsheets by hand. Design how data is stored and read so each of these works well."

**Then:** "A price change takes 10 minutes to show up in search and 5 seconds on the product page; marketing wants it consistent. Also, search must never show a product as in stock when it isn't."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Which reads hurt and how often? → assume: product pages ~3k/s peak (same ~5k popular products), search ~500/s, "my orders" ~50/s, dashboard used by ~20 staff, finance monthly.
- How fresh must each read be? → assume: product page and search within a few seconds; dashboard within a minute; finance next day; **stock and price at checkout must be exact** (always from Postgres).
- Search needs? → assume: full-text in several languages, typos, filters (size, colour, price range), facet counts, relevance ordering.
- Dashboard metrics? → assume: revenue, orders, conversion per hour/day per category and country.
- Team size and ops budget? → assume: small team; prefer managed services (RDS, ElastiCache, OpenSearch Service, a warehouse) and add each only when needed.
- Numbers → assume: 200k products × ~5 KB = 1 GB of product documents; 20k orders/day ≈ 0.25/s writes; reads dominate by > 1000:1.

## Design

**Principle:** Postgres stays the **only source of truth** for products, prices, stock and orders. Each heavy read gets its own **read model** shaped for that query, fed from Postgres by events, and rebuildable from it.

**1. Change events.** Every write that matters (product, price, stock, order) commits a row to an `outbox` table in the same transaction; a relay (or Debezium CDC on the WAL) publishes `product.updated {id, version}`, `stock.changed`, `order.placed` to a stream (SNS→SQS per consumer, or Kafka).

**2. Five read paths**
| Read | Store | How it's fed | Freshness |
|---|---|---|---|
| product page `GET /products/:slug` | Redis (cache-aside) + CDN for the HTML/JSON shell | miss → Postgres; `product.updated` → delete key | seconds |
| search "shoes, size 42, < €100" | OpenSearch index `products` | consumer re-reads the product from Postgres and indexes it (with `version`) | seconds |
| "my orders" | Postgres itself, index `(customer_id, created_at DESC)` | — | exact |
| sales dashboard | rollup tables (`sales_hourly`) in Postgres, or ClickHouse if they grow | consumer of `order.placed` upserts hourly rollups | ~1 min |
| finance / analysts | warehouse (Snowflake / Redshift / BigQuery) | nightly or CDC load of orders, payments, refunds | next day |

**3. Checkout never trusts a read model.** Price and stock are re-read from Postgres in the order transaction (`SELECT … FOR UPDATE` on stock, or a conditional `UPDATE stock SET qty = qty - $n WHERE qty >= $n`). Read models only *display*.

**4. Rebuild path for every read model:** flush-and-reload for Redis; reindex-from-Postgres into a new OpenSearch index then swap an alias; recompute rollups for a date range; reload the warehouse table.

## Deep dives

**1. Why not keep everything in Postgres?** Product pages: 3k/s of the same rows is cheap in Redis and wastes DB connections. Search: `LIKE '%shoe%'` can't use a B-tree index, has no relevance or typo tolerance; Postgres full-text (`tsvector` + GIN) is a valid first step for one language and simple filters, and OpenSearch comes when you need facets, multilingual analyzers and relevance tuning. Dashboard: `SUM … GROUP BY` over months of orders on the OLTP DB competes with checkouts; pre-aggregate on write. Finance: joins across orders, payments, refunds, marketing spend belong in a warehouse with BI tools, away from production. "My orders" stays in Postgres: a small indexed query, no reason to copy it.

**2. Price consistency (twist, part 1).** Search lags 10 minutes because indexing is batched; the page lags 5 s because of a TTL. Fix: both are driven by the same `product.updated` event; the cache key is **deleted** on the event (not left to expire), and the search consumer indexes immediately with the product `version` as an external version so out-of-order updates can't overwrite newer data. Typical lag becomes ~1–2 s for both. They can still disagree for that second; the **checkout price comes from Postgres**, and the cart shows "price changed" if it differs. Rejected: dual writes from the app to DB + Redis + OpenSearch (one fails, they diverge forever).

**3. Stock in search (twist, part 2).** "Never show in stock when it isn't" can't be guaranteed by any eventually consistent index. Chosen: search indexes a coarse `in_stock` flag (fed by `stock.changed` when it crosses zero) for filtering; the product page and cart read live stock from Postgres/Redis for the specific item; checkout's conditional `UPDATE` is the only real guarantee. Tell product that "never" is achievable at checkout, not in search results.

**4. Eventual consistency, named.** Each read model is seconds behind. Make it visible: monitor consumer lag per read model, alert if search is > 30 s behind, and keep a manual "reindex product X" tool for support.

## Traps

- Writing to Postgres, Redis and OpenSearch from the request handler (dual writes): partial failures leave them inconsistent with nothing to repair them; use outbox/CDC.
- Taking price or stock for checkout from the cache or search index.
- Updating the cache on write instead of deleting it: two concurrent writers can leave the older value cached.
- Adding OpenSearch, ClickHouse and a warehouse on day one for 200k products: each is a system to run; say what would trigger each one.
- Running the month-end dashboard query on the primary (or a replica that's also serving checkout reads) instead of pre-aggregating.

## Say it (60–90 s)

I keep Postgres as the single source of truth for products, prices, stock and orders, and give each heavy read its own read model, fed by events from an outbox so nothing depends on dual writes. Product pages read through Redis, with the key deleted on every product update, and a CDN in front. Search goes to OpenSearch, indexed by a consumer that re-reads the product from Postgres and uses the product version so stale updates can't win. My orders stays in Postgres with an index on customer and date. The sales dashboard reads hourly rollups maintained by a consumer of order events, and finance works in a warehouse loaded nightly. Every read model can be rebuilt from Postgres. For consistency, price changes drive both the cache delete and the reindex from the same event, so they converge in a second or two, and checkout always re-reads price and stock from Postgres inside the order transaction, which is the only place I can guarantee 'in stock'.

## Follow-ups

**Q:** Why not Postgres full-text search instead of OpenSearch?
**A:** It's a good first step: `tsvector` with a GIN index handles one language and simple filters. Move to OpenSearch for facets, typo tolerance, several languages and relevance tuning, or when search load should be off the primary.

**Q:** How do you reindex all products without downtime?
**A:** Build a new index `products_v2` from Postgres while the consumer writes to both, then switch the `products` alias atomically and delete the old index.

**Q:** The event consumer for search is down for an hour. What happens?
**A:** Events wait in the queue/stream; search is an hour stale but correct afterwards. Alert on lag; if the backlog is huge, reindex changed products by `updated_at` instead of replaying.

</details>

## Theory in the notes

- [10-system-design/01-system-design-framework.md](../../10-system-design/01-system-design-framework.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [03-databases/05-analytical-and-document-databases.md](../../03-databases/05-analytical-and-document-databases.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
