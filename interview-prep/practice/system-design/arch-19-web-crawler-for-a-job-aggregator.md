# arch-19. Web crawler for a job aggregator

*Data · Medium*

## The question

"We're building a job search site that aggregates postings from ~250k company career pages and job boards. Roughly 30M job pages are live at any time; postings appear and close every day. Users hate applying to jobs that are already closed. Design the crawler: what to fetch, when, and how to be a polite crawler."

**Then:** "A big applicant-tracking vendor hosts career pages for 30k of our companies on one domain, so politeness limits make a full pass over it take four days. And about 5% of sites only render jobs with JavaScript."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Discovery? → assume: seed list of company career URLs (from sales and a company database), plus links found while crawling; sitemaps where available.
- Freshness target? → assume: new jobs visible within 24 h; closed jobs removed within 24 h.
- Politeness rules? → assume: obey robots.txt (RFC 9309), identify our crawler with a user agent and contact URL, at most 1 request per host every 1-2 s by default, slower if the site asks.
- What do we extract? → assume: title, company, location, salary, description, posting date; prefer schema.org `JobPosting` JSON-LD, which many sites publish for search engines.
- Numbers → assume: listing pages daily + detail pages every 3-7 days ≈ 15M fetches/day ≈ 175/s avg. ~150 KB avg page → ~2.2 TB/day downloaded (~200 Mbps). Extracted jobs ~5 KB × 30M ≈ 150 GB in Postgres; raw HTML compressed to S3, kept 14 days for re-parsing.
- Legal → assume: legal has reviewed sources; we honor robots.txt and opt-out requests.

## Design

**1. Frontier** (Postgres, ~100M URL rows is fine with the right indexes):
```sql
urls(url_hash bytea PRIMARY KEY, url text, host text, kind text,   -- listing | job | sitemap
  priority smallint, next_fetch_at timestamptz, interval_s int,
  etag text, last_modified text, content_hash bytea, last_status int,
  unchanged_count int, job_id bigint)
CREATE INDEX ON urls (host, next_fetch_at);
hosts(host PRIMARY KEY, next_allowed_at timestamptz, delay_ms int, max_concurrency int,
  robots_txt text, robots_fetched_at timestamptz, error_streak int)
```

**2. Scheduling = per-host queues.** Workers claim a **host**, not a URL: `SELECT … FROM hosts WHERE next_allowed_at <= now() … FOR UPDATE SKIP LOCKED`, take up to N due URLs for it ordered by priority, set `next_allowed_at = now() + delay`. Politeness is enforced by construction, and thousands of hosts are crawled in parallel.

**3. Fetch.** Refresh robots.txt if older than 24 h (RFC 9309's caching limit). Conditional GET with `If-None-Match`/`If-Modified-Since` (304 costs almost nothing). 10 s timeout, 5 MB cap, ≤ 5 redirects, shared DNS cache. Raw response to S3.

**4. Parse.** Extract JSON-LD `JobPosting` first; per-site extraction rules second; a generic extractor last. Normalize links (lowercase host, drop fragments, strip `utm_*` and session IDs, sort query params) and insert new ones `ON CONFLICT DO NOTHING`.

**5. Dedupe.** URL level by `url_hash`. Job level by a hash of normalized (company, title, location, description); the same job on 3 boards becomes one job with 3 sources. Near-duplicates (template text changes) by SimHash.

**6. Recrawl.** Adaptive: content changed → `interval /= 2` (min 6 h); unchanged → `interval *= 1.5` (max 7 days for job pages, 24 h for listings). A job URL returning 404/410, or disappearing from its listing page twice, → job `closed` immediately.

**7. Metrics:** fetches/s, error rate per host, freshness (age of last successful fetch per live job), share of jobs closed by us vs reported by users.

## Deep dives

**1. One host with 30k companies (twist, part 1).** Per-host politeness at 1 req/s gives 86k fetches/day for that host, while it holds ~1M job pages. Crawling it page by page can't meet 24 h and loads their servers. Chosen: use the vendor's public job-board API or feed (large ATS vendors expose a JSON endpoint per company that returns all open jobs in one call): 30k calls/day instead of a million, with complete data and closed jobs visible by absence. Ask the vendor for a partnership feed and a higher agreed rate. Rejected: raising our rate on their domain without permission (we get blocked, and it's rude); spreading requests across many IPs to dodge per-host limits (same, and it breaks the rules we claim to follow).

**2. JavaScript-rendered sites (twist, part 2).** A headless Chromium (Playwright) render costs 10-50x a plain fetch in CPU and memory. Chosen: detect the need (HTML has no job content and no JSON-LD), then first look for the JSON/XHR endpoint the page calls and fetch that directly; render only what remains, in a separate worker pool with its own concurrency and its own per-host budget. Rejected: rendering everything (cost), skipping those sites (5% of jobs, often large companies).

**3. Crawler traps and frontier blow-up.** Calendars, faceted filters (`?sort=…&page=…&loc=…`) and session IDs create infinite URLs. Chosen: per-host URL budget, max depth from seed, query-parameter rules learned per host (params that never change content are stripped), and robots.txt disallow rules (which often list exactly these paths). Rejected: crawling everything reachable.

**4. Stale postings.** Users' main complaint. Closed detection has two signals: the detail page 404s/410s or says "no longer accepting", or the job vanishes from its listing page (listings are recrawled daily and are cheap). Mark closed on either; reopen if it comes back.

## Traps

- A global URL queue with no per-host scheduling: workers hammer one site while thousands sit idle.
- Ignoring robots.txt or treating a 5xx on robots.txt as "allowed": RFC 9309 says to assume full disallow when robots.txt is unreachable because of server errors (a 4xx means no rules).
- Re-downloading unchanged pages: no conditional GETs, no adaptive intervals.
- Rendering every page in headless Chrome.
- Scraping HTML from a vendor that offers a structured API or feed.
- No URL normalization or trap limits: the frontier fills with infinite variants of the same page.

## Say it (60–90 s)

The frontier is a Postgres table of URLs with a next-fetch time and an adaptive interval, plus a hosts table with each host's next-allowed time. Workers claim a host with SKIP LOCKED, take a few due URLs for it and push its next-allowed time forward, so politeness is built into scheduling and thousands of hosts run in parallel. Before fetching I refresh robots.txt at most daily and obey it; fetches are conditional GETs, so unchanged pages return 304. Raw pages go to S3 so I can re-parse without re-fetching. Extraction prefers the schema.org JobPosting JSON-LD that many sites publish for search engines, then per-site rules. URLs are normalized and deduped by hash, and the same job on several boards is merged by a content hash. Pages that change get recrawled more often, unchanged ones less, and a job is closed as soon as its page 404s or it disappears from the listing. For the vendor hosting thirty thousand companies, I use their public job-board API, one call per company, instead of crawling a million pages. For JavaScript sites, I first look for the JSON endpoint the page calls and only render the rest in a separate headless pool.

## Follow-ups

**Q:** How would you scale to 1B pages?
**A:** Move the frontier to a sharded key-value store partitioned by host hash, keep per-host queues within a shard, use a Bloom filter in front of the URL-seen check, and run fetchers close to the frontier shard. The per-host scheduling idea stays the same.

**Q:** A site starts returning 429s or 503s.
**A:** Back off that host exponentially (double `delay_ms`, honor `Retry-After`), pause it after an error streak, alert if it's an important source.

**Q:** How do you know the extractor broke on a site?
**A:** Per-host extraction success rate and field completeness (salary/location present) compared with the previous week; a sudden drop pages the owner of that site's rules.

</details>

## Theory in the notes

- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [10-system-design/01-system-design-framework.md](../../10-system-design/01-system-design-framework.md)
