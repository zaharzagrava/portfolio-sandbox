<div align="center">
  <h1>Marketplace: a distributed-systems showcase</h1>
  <p><i>NestJS · Next.js · PostgreSQL · Kafka (Redpanda) · Redis · Stripe · ClickHouse</i></p>
</div>

---

# 🚀 Enterprise Architecture Showcase

Welcome to the laboratory. This is not a standard CRUD application—it is a **battle-tested showcase of distributed systems design, fault tolerance, and high-concurrency patterns.**

If you want to see how production-grade code, edge-case failure handling and architectural trade-offs look in practice, you are in the right place. Dive into the code or check out the feature showcases below to see how I build systems designed to scale.

> **Looking for something specific?** Jump to the [problem index](#what-i-can-build-for-you): payments, concurrency, multi-tenancy, search, realtime, AI.

## Infrastructure commands

```
moon run :infra-up
moon run :infra-setup --force
   --force matters: without it moon replays a cached result and skips the setup.
5. Services, one terminal each:
moon run :dev-api        # core :8000
moon run :dev-bff        # :8006
moon run :dev-sse        # :8001
moon run :dev-worker     # :8003
moon run :dev-projector  # :8002
moon run :dev-web        # :3000
```

## Spec-driven Development Commands

Generating constitution:

```
/speckit.constitution Read the architectural patterns and notes inside interview-prep/. Use these notes as the absolute source of truth to generate this project's constitution.

You may scan the existing codebase for context, but treat the code as an imperfect, AI-generated draft. If the codebase contradicts the notes in interview-prep/, the notes win.

Extract these patterns into strict, falsifiable, decision-ready rules.
DO NOT write vague platitudes like "maintain quality" or "write clean code". Every principle must be a hard constraint that can be objectively validated during a pull request.

Ensure the constitution explicitly defines:
1. The required architectural boundaries (e.g., how routing, data access, and state management must be separated).
2. Strict rules for what components are allowed to communicate with each other.
3. The exact testing mandate (what must be tested and how).
```

Running spec generation:

```
Suggested order:
1. Commit.
2. DRY_RUN=1 scripts/sdd/write-specs.sh S10 W03 J01 to read one prompt of each kind.
3. Pilot with scripts/sdd/write-specs.sh S01 S10 and read the results.
4. Run the full scripts/sdd/write-specs.sh.
5. Review the questions.md files.
```

Full unattended run (after the pilot; details in [`docs/architecture/sdd-runbook.md`](docs/architecture/sdd-runbook.md)):

```bash
# 1. Commit, then write all 67 specs (55 backend S, 7 web W, 5 journeys J). Takes roughly 13–17 hours.
#    Unfinished specs (no .spec-done marker) are cleared and redone, including the S01/S10 pilot.
#    Failures are retried after 10/30/60/120 min, then the run moves on. Re-run the same command to resume.
tmux new -s specs                                   # detach: Ctrl-b d, re-attach: tmux attach -t specs
cd <repo root>
systemd-inhibit --what=sleep:idle --why="SDD spec run" \
  scripts/sdd/write-specs.sh 2>&1 | tee -a specs-run.log

# Progress: target is 67
tail specs-run.log
ls specs/*/*/.spec-done | wc -l

# 2. Optional: veto any default (agents pick the most production-grade option and tag changes [BREAKING])
scripts/sdd/review-questions.sh

# 3. Commit, then implement spec by spec (needs the test stack; W and J also need the dev stack)
docker compose -f docker-compose.test.yaml up -d
# For W and J, each in its own terminal (infra-up and dev-monolith keep running in the foreground):
#   moon run :infra-up        # dev stores
#   moon run :infra-setup     # once the stores are up
#   moon run :dev-monolith    # API + workers + projectors on :8000, watch mode
COMMIT=1 scripts/sdd/implement-specs.sh
```

## Developer tooling

Three things live next to the code: an Obsidian vault over the repo, a generated codebase map, and the spec-driven
development scripts.

### Obsidian vault

Open the repo root as a vault (Obsidian → Open folder as vault). `.obsidian/` is gitignored, so a fresh clone has to
recreate its settings. Obsidian only indexes markdown, so keep it away from `node_modules` before the first open.

1. Create `.obsidian/app.json`:

   ```json
   {
     "userIgnoreFilters": [
       "/(^|\\/)node_modules\\//",
       "/(^|\\/)\\.git\\//",
       ".agents/",
       ".specify/",
       ".claude/",
       ".moon/",
       ".github/",
       ".aider",
       "infra/",
       "packages/",
       "scripts/"
     ],
     "useMarkdownLinks": true,
     "newLinkFormat": "relative",
     "alwaysUpdateLinks": true
   }
   ```

   Same list in the UI: Settings → Files & links → Excluded files → Manage. If you open the vault first, close and
   reopen it after editing the file.

2. Excluded folders still show as empty shells in the file explorer. Hide them with a CSS snippet saved as
   `.obsidian/snippets/hide-noise.css`, then switch it on under Settings → Appearance → CSS snippets:

   ```css
   .nav-folder:has(> .nav-folder-title[data-path$="node_modules"]),
   .nav-folder:has(> .nav-folder-title[data-path="infra"]),
   .nav-folder:has(> .nav-folder-title[data-path="packages"]),
   .nav-folder:has(> .nav-folder-title[data-path="scripts"]) {
     display: none;
   }
   ```

   The code stays on disk and in git; it is only out of the vault's index, graph and sidebar.

3. Links to code (`.ts` files) are not notes, so Obsidian hands them to your system's default app. To open them in the
   editor window that already has this repo open, make the editor the default for those file types. On Linux the
   catch is that the system classifies `.ts` as a Qt translation file (`text/vnd.trolltech.linguist`) and `.tsx` as
   `application/x-tiled-tsx`, so setting `text/x-typescript` does nothing (check with `gio info FILE | grep -i type`):
   `xdg-mime default cursor.desktop text/vnd.trolltech.linguist application/x-tiled-tsx text/x-typescript`.
   Line anchors (`#L19`) are ignored that way.

Folders in the vault:

| Folder                                           | Owner                 | Notes                                                                                       |
| ------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------- |
| `docs/humans/`                                   | the docs generator    | Rewritten on every run. Do not hand-edit; any other `.md` file in it is deleted.            |
| `interview-prep/`                                | you                   | Hand-written theory notes. `interview-prep/my-practice/` is gitignored (private exercises). |
| `docs/architecture/`, `docs/runbooks/`, `specs/` | you / the SDD scripts | Hand-written or agent-written, committed.                                                   |

### Codebase map (`scripts/docs`)

Builds `docs/humans/`: one page per unit, flow and topic, linked into a graph that can be browsed in Obsidian. Static
analysis finds the structure; an LLM writes the words. Details, limits and configuration:
[`scripts/docs/README.md`](scripts/docs/README.md). Needs Node 22.18 or newer, no install.

```sh
pnpm docs:extract                           # what static analysis found (free, instant)
pnpm docs:plan --unit domain/payments       # how much a run would cost (no LLM calls)
pnpm docs:generate --unit domain/payments   # one unit: file summaries -> topic map -> topic pages -> unit page
pnpm docs:generate                          # everything (large; see below)
pnpm docs:check --strict                    # CI gate: stale summaries, or pages out of sync with the cache
pnpm docs:render                            # rebuild the markdown from the cache only (no LLM)
pnpm docs:theory                            # link interview-prep sections to the code that implements them
```

- `generate` renders at the end, so there is no separate step for Obsidian: open `docs/humans/README.md`.
- **Cache:** `docs/humans/.cache/` is keyed by a hash of each node's source and inputs. Commit it: a fresh clone then
  regenerates only what changed, and everyone renders identical pages. `--force` regenerates the selected nodes anyway.
- **Order:** a topic page can link to another unit only if that unit's topic map already exists. For a full run, first
  do `pnpm docs:generate --level file,capmap` (every unit's file summaries and topic map), then generate units in any
  order. `--unit` takes several names: `--unit domain/orders,domain/marketing`.
- **LLM access:** `--provider auto` uses `ANTHROPIC_API_KEY` if set (fast, parallel), otherwise the logged-in `claude`
  CLI (set `DOCS_CLAUDE_CONFIG_DIR` to run it under a separate Claude Code profile). `--provider mock`
  tests the pipeline with placeholder text; use it only with a throwaway `outDir`, because it writes into the cache.
- **Cost and time:** `--max-calls N` is a hard cap. One unit takes minutes; the whole repo is a few thousand calls
  (mostly small ones), so use an API key for that run.
- **Do not interrupt a run.** The topic-page level saves its cache only when the whole level finishes, so Ctrl+C loses
  the pages written in that run.
- **Depth:** a topic page splits itself into sub-topics until pieces are self-explanatory. Tune `maxConceptDepth`
  (default 4) and `maxConceptsPerUnit` (default 40) in `scripts/docs/docs.config.json`.
- **Theory links:** `pnpm docs:theory` adds an **In this codebase** block under every section of the notes in
  `interview-prep/`, at any heading depth. Each link is Ctrl+clickable and lands on the exact function (`file.ts#L21`).
  Code is always linked; topic pages are linked next to it only if they have been generated.
- **Theory links, safety:** it writes only between the `theory-links:start` and `theory-links:end` HTML-comment
  markers, so your text is never changed, and it never reads `interview-prep/my-practice/`.
  `docs/humans/theory-coverage.md` shows the gaps in both directions.
- **After a reimplementation:** run the two theory commands below again. Only changed files, and only notes whose
  candidates changed, are redone. For topic links, generate topic pages for the units you want to study
  (`pnpm docs:generate --unit ...`), then run `pnpm docs:theory` again.

Cheap path for theory links, once the code you want linked exists (no topic pages needed):

```sh
pnpm docs:generate --level file   # summaries of every file and its exported functions (~800 small Haiku calls)
pnpm docs:theory                  # ~45 calls: link every note section to the code that implements it
git diff interview-prep           # review: read the model's one-sentence "how" lines critically
```

### Spec-driven development (`scripts/sdd`)

Bulk spec writing and implementation on top of spec-kit, driven by the 67-row catalog in
[`scripts/sdd/capabilities.tsv`](scripts/sdd/capabilities.tsv). Full procedure:
[`docs/architecture/sdd-runbook.md`](docs/architecture/sdd-runbook.md).

```sh
DRY_RUN=1 scripts/sdd/write-specs.sh S10       # print the prompt for one capability, run nothing
scripts/sdd/write-specs.sh S01 S10             # pilot: write these specs
scripts/sdd/write-specs.sh payments web        # by domain column (`web` and `journeys` too)
scripts/sdd/write-specs.sh                     # all capabilities; resumes if re-run
scripts/sdd/review-questions.sh                # the [BREAKING]/[CONTRACT] defaults the agents chose
COMMIT=1 scripts/sdd/implement-specs.sh S10    # plan -> tasks -> analyze -> implement -> converge -> gate
```

- A spec counts as written when `spec.md`, `test-plan.md`, `gaps.md` and `questions.md` exist and `.spec-done` is
  present; interrupted ones are cleared and redone. Failures wait 10/30/60/120 minutes (`RETRY_WAITS`), then the run
  moves on.
- Implementation stops at the first failing gate and resumes from `.implemented` markers. Backend specs need
  `docker compose -f docker-compose.test.yaml up -d`; web and journey specs also need `moon run :infra-up`,
  `moon run :infra-setup` and `moon run :dev-monolith`.
- To use a separate Claude Code profile, set `CLAUDE_CONFIG_DIR=DIR` for these scripts. Long runs:
  `systemd-inhibit --what=sleep:idle` inside `tmux`, as in the runbook.

---

# What I can build for you

Each section is a problem a real team has, and how I designed the solution: the architecture, not a tutorial.

> **What this is, honestly:** this repo shows how I **architect** systems, not a finished product. It is built spec-first: every section below is a designed solution with a spec (linked), and each spec has a `gaps.md` listing exactly where the code still differs. Most capabilities have a first-pass implementation, but the spec-driven implementation is not fully run yet. Some details below are ahead of the code. The only thing between the specs and a complete implementation is my time and AI usage limits, not the design. Per-capability progress is in [`pattern-map.md`](docs/architecture/pattern-map.md).

**Money**

[Never double-charge a customer](#never-double-charge-a-customer) · [Never lose an event between DB and Kafka](#never-lose-an-event-between-db-and-kafka) · [A ledger that always balances](#a-ledger-that-always-balances) · [Pay sellers exactly once](#pay-sellers-exactly-once) · [Subscription billing that never double-bills](#subscription-billing-that-never-double-bills) · [Metered usage and plan entitlements](#metered-usage-and-plan-entitlements) · [As-of financial reports (bitemporal)](#as-of-financial-reports-bitemporal) · [Ad-click billing, exactly once](#ad-click-billing-exactly-once)

**Orders & scale**

[Cart and checkout that survive a bad network](#cart-and-checkout-that-survive-a-bad-network) · [Never oversell a flash sale](#never-oversell-a-flash-sale) · [A million people, one on-sale moment](#a-million-people-one-on-sale-moment) · [Fair auctions under bid storms](#fair-auctions-under-bid-storms) · [Rate limiting that works across a fleet](#rate-limiting-that-works-across-a-fleet) · [Background jobs that run exactly once](#background-jobs-that-run-exactly-once) · [A cache that survives viral traffic](#a-cache-that-survives-viral-traffic)

**Platform & security**

[Multi-tenant SaaS that cannot leak data](#multi-tenant-saas-that-cannot-leak-data) · [Auth that survives a security review](#auth-that-survives-a-security-review) · [A public API sellers can build on](#a-public-api-sellers-can-build-on) · [Webhooks receivers can trust](#webhooks-receivers-can-trust) · [An embeddable checkout widget](#an-embeddable-checkout-widget) · [Run customers' code without getting owned](#run-customers-code-without-getting-owned) · [Serverless workers that retry correctly](#serverless-workers-that-retry-correctly) · [Notifications that respect people and providers](#notifications-that-respect-people-and-providers) · [One platform toolkit under every service](#one-platform-toolkit-under-every-service) · [A BFF that degrades instead of failing](#a-bff-that-degrades-instead-of-failing)

**Data pipelines & search**

[Import a 5 GB catalog without running out of memory](#import-a-5-gb-catalog-without-running-out-of-memory) · [Export a million orders in constant memory](#export-a-million-orders-in-constant-memory) · [Two-way Shopify sync without ping-pong](#two-way-shopify-sync-without-ping-pong) · [Offline devices that sync without lost sales](#offline-devices-that-sync-without-lost-sales) · [Search reindex with zero downtime](#search-reindex-with-zero-downtime) · [Autocomplete under a 40 ms budget](#autocomplete-under-a-40-ms-budget) · ["Bought together" and "Trending now"](#bought-together-and-trending-now) · [Find stock near me](#find-stock-near-me) · [A polite, SSRF-safe crawler](#a-polite-ssrf-safe-crawler) · [Analytics events that survive ad-blockers](#analytics-events-that-survive-ad-blockers)

**Realtime & community**

[Chat that never loses or reorders messages](#chat-that-never-loses-or-reorders-messages) · [Push to the browser with replay after reconnect](#push-to-the-browser-with-replay-after-reconnect) · [Collaborative editing at scale](#collaborative-editing-at-scale) · [A follow feed that survives celebrities](#a-follow-feed-that-survives-celebrities) · [A live stream with thousands of comments per second](#a-live-stream-with-thousands-of-comments-per-second) · [Discussion threads that stay cheap at 50,000 comments](#discussion-threads-that-stay-cheap-at-50000-comments) · [Same-day courier dispatch](#same-day-courier-dispatch)

**AI**

[LLM document extraction you can put in a KYC flow](#llm-document-extraction-you-can-put-in-a-kyc-flow) · [RAG where permissions live inside the query](#rag-where-permissions-live-inside-the-query) · [A streaming LLM assistant with tools](#a-streaming-llm-assistant-with-tools)

**Media, content & experiments**

[Photos: from upload to safe, served images](#photos-from-upload-to-safe-served-images) · [Video pipeline as a DAG](#video-pipeline-as-a-dag) · [Dropbox-style file sync, dedupe and digital delivery](#dropbox-style-file-sync-dedupe-and-digital-delivery) · [A CMS for brand stories behind a CDN](#a-cms-for-brand-stories-behind-a-cdn) · [Feature flags with no network call per check](#feature-flags-with-no-network-call-per-check) · [A/B tests you can trust](#ab-tests-you-can-trust) · [Seller leaderboards and a live sales dashboard](#seller-leaderboards-and-a-live-sales-dashboard) · [Short and affiliate links](#short-and-affiliate-links)

---

## Money

### Never double-charge a customer

*Idempotency keys · unknown-outcome handling · circuit breaker · saga with orders*

Retries, double-clicks, and a payment provider that goes silent after your request.

- `Idempotency-Key` per buyer: same key and body replays the answer; same key with a different body is `422`; same key in flight is `409`
- Exactly one payment per order, enforced by the database. Amount and currency come from the order, never the client
- `202` first, charge async. The **order is the provider-side idempotency reference**, so a retry can't create a second charge
- Provider timeout → `UNKNOWN`, settled by asking the provider about our reference with backoff. Never a blind resend
- Every provider answer is classified (paid, declined, customer action required, rejected, unknown) and checked against the amount we asked for
- Versioned, recorded status transitions. Payment, ledger posting and outbox event commit together or not at all
- Late payments and cancel races are refunded by the saga with orders. Provider breaker per operation

→ Spec: [S13](specs/domains/S13-payment-intents/spec.md), [S10](specs/domains/S10-cart-checkout/spec.md) · Where code differs: [S13](specs/domains/S13-payment-intents/gaps.md), [S10](specs/domains/S10-cart-checkout/gaps.md) · [First-pass code](packages/backend/libs/domains/payments)

### Never lose an event between DB and Kafka

*Transactional outbox · CDC · idempotent consumers · replay*

- The event is appended in the **same transaction** as the state change. Non-Nest writers (Lambda workers) have a framework-free append
- Two relays publish the same message, at-least-once, in per-aggregate order: a `SKIP LOCKED` poller by default, or Debezium CDC of the outbox table only
- Consumers declare how they stay idempotent (inbox, version guard or natural). Poison messages are dead-lettered with reason codes
- Version-guarded sinks for Redis, Elasticsearch, DynamoDB, Scylla and ClickHouse
- Read-your-writes: a checkpoint per read model, so a request can wait briefly, then fall back or answer "still processing"
- Rebuild a read model with a shadow copy, a promotion gate and rollback

→ Spec: [S53](specs/domains/S53-events-projections/spec.md) · Where code differs: [S53](specs/domains/S53-events-projections/gaps.md) · [First-pass code](packages/backend/libs/infrastructure/outbox)

### A ledger that always balances

*Double-entry · hot-account sharding · reconciliation*

- Every money movement is a journal whose lines sum to zero, written once and never edited. Each (kind, reference) posts at most once
- Postings join the caller's transaction. Unbalanced journals fail at `COMMIT` via a deferred constraint trigger
- Hot accounts (every sale touches the fee account) are sharded, summed on read and consolidated by a sweep
- Locks are always taken in sorted order, and a posting never waits forever
- Settlement splits the net sale among shops to the cent, exactly once, even when a refund races it
- Balances are kept with the journals plus a fast read model. Nothing is ever computed by summing history
- Daily reconciliation against the provider's statement for a closed UTC day; every difference becomes an issue

→ Spec: [S14](specs/domains/S14-ledger-reconciliation/spec.md) · Where code differs: [S14](specs/domains/S14-ledger-reconciliation/gaps.md) · [First-pass code](packages/backend/libs/domains/payments)

### Pay sellers exactly once

- A weekly run creates one payout per shop in a **single atomic step**: payout row, ledger move (seller balance → payout clearing) and the queued transfer
- Re-runs, concurrent runs and resumed runs create nothing twice. Reserve is a platform default with a per-shop override
- Transfer idempotency key = the payout's own ID, plus a claim step so two workers can't both send
- States `PENDING → SENDING → PAID | FAILED | UNKNOWN`. Unknown means ask the provider, never resend. Definite rejection returns the money to the seller
- A destination change starts a cooling period. A daily audit checks that "paid" payouts exist at the provider with the same amount, currency and destination

→ Spec: [S15](specs/domains/S15-payouts/spec.md) · Where code differs: [S15](specs/domains/S15-payouts/gaps.md) · [First-pass code](packages/backend/libs/domains/payments)

### Subscription billing that never double-bills

*State machine · proration · dunning*

- Prices are versioned and the store refuses an in-place edit. One live subscription per subject
- Billing run is single-run and idempotent: one renewal invoice per (subscription, period). Month-end anchors survive short months
- One charge attempt at a time per invoice, with a provider key per attempt. Unknown outcomes are settled by lookup, never re-sent as a new charge
- Dunning on days 1/3/7, then `UNPAID`. Mid-period changes credit the old price and charge the new on UTC day boundaries, rounded once and **previewed exactly as invoiced**
- Net credits go to a credit balance applied to later renewals

→ Spec: [S17](specs/domains/S17-subscriptions/spec.md) · Where code differs: [S17](specs/domains/S17-subscriptions/gaps.md) · [First-pass code](packages/backend/libs/domains/billing)

### Metered usage and plan entitlements

- Other domains ask "what does this plan allow?" (feature, count limit, monthly quota), never "which plan is it?"
- Entitlement cache is event-invalidated and **version-guarded**, so a slow load can't overwrite newer state. Stale-on-error, stampede-safe
- Usage ingestion is idempotent, with a late-arrival window and dead-lettering
- A settlement ledger makes each unit billable exactly once. Late usage is priced as an **adjustment on the next invoice**; closed periods never change

→ Spec: [S18](specs/domains/S18-usage-entitlements/spec.md) · Where code differs: [S18](specs/domains/S18-usage-entitlements/gaps.md) · [First-pass code](packages/backend/libs/domains/billing)

### As-of financial reports (bitemporal)

*"What was my March statement as we knew it on April 1st?"*

- Commission rates carry two time axes (when true, when believed). Setting a rate never overwrites history; overlapping current beliefs are impossible
- Closed months are served from a frozen snapshot, and any month can be shown as known at an earlier instant
- Later corrections become visible **adjustments booked in the open month**, so closed numbers never change
- Facts arrive as copies from other domains' events, idempotent and rebuildable by replay. Reconciliation raises findings and never auto-corrects
- Streamed CSV export with backpressure and formula-injection-safe cells

→ Spec: [S16](specs/domains/S16-seller-statements/spec.md) · Where code differs: [S16](specs/domains/S16-seller-statements/gaps.md) · [First-pass code](packages/backend/libs/domains/statements)

### Ad-click billing, exactly once

- Served ads carry a signed, expiring click token that identifies one impression. Each impression counts at most once, and a click **always** redirects the shopper
- A Kafka-transactions aggregator is keyed per campaign/minute with hot-key salting, so replays replace rather than add
- Hourly charge capped by the daily budget and posted once to the ledger
- A daily reconciliation recomputes from raw deduplicated clicks and posts adjustments; closed periods are never mutated

→ Spec: [S36](specs/domains/S36-sponsored-listings/spec.md) · Where code differs: [S36](specs/domains/S36-sponsored-listings/gaps.md) · [First-pass code](packages/backend/libs/domains/marketing)

---

## Orders & scale

### Cart and checkout that survive a bad network

- Guest cart under a signed cookie, merged into the user's cart on login. The cart never touches the relational database
- One retry-safe checkout request: prices recomputed server-side, seller discounts allocated exactly, one order split into per-shop orders, `202`
- Stock held for 15 minutes via the catalog's stock command. Never oversold, released exactly once, recovered after a crash between steps (saga with compensation)
- Order state machine with guarded transitions, history and an event per transition
- Only the provider's **signed webhook** marks an order paid, never the browser redirect: raw-body signature, 5-minute tolerance, dedupe on event ID, ack first, process async

→ Spec: [S10](specs/domains/S10-cart-checkout/spec.md) · Where code differs: [S10](specs/domains/S10-cart-checkout/gaps.md) · [First-pass code](packages/backend/libs/domains/orders)

### Never oversell a flash sale

- Units move out of regular stock into many independent buckets in a fast store, so thousands of buyers don't queue on one hot counter
- Admission control at the entrance: a per-sale attempts-per-second limit plus a per-buyer limit. Everyone else is turned away fast with a retry hint and no side effects
- Reserve / release / convert is all-or-nothing, with a per-customer quantity cap
- Never oversell **even after a fast-store failure**: a periodic check against durable records, and a final reconciliation that returns unsold units

→ Spec: [S11](specs/domains/S11-flash-sales/spec.md) · Where code differs: [S11](specs/domains/S11-flash-sales/gaps.md) · [First-pass code](packages/backend/libs/domains/orders)

### A million people, one on-sale moment

*Waiting room · seat holds · admission control*

- Virtual waiting room: pre-sale arrivals ordered randomly (refreshing early gains nothing), admitted at a fixed rate, with position and ETA
- Admission token is short-lived and bound to the event **and** buyer. Booking refuses anything without it before touching any store
- Seat holds last 10 minutes: exactly one winner per seat, multi-seat holds all-or-nothing, expiry by itself
- Confirmation happens exactly once, even with retries, expiry races and a crash between stores. The database refuses two confirmed bookings for a seat
- Queue-length cap (load shedding), bot-check hook, per-person ticket limit. Seat map is a cheap display-only picture, never the authority

→ Spec: [S22](specs/domains/S22-booking/spec.md) · Where code differs: [S22](specs/domains/S22-booking/gaps.md) · [First-pass code](packages/backend/libs/domains/launch-events)

### Fair auctions under bid storms

- Bids on one auction apply one at a time in strict order. A retried bid never counts twice. Every acknowledged bid is durable
- **Proxy bidding**: price rises only to second-highest max plus one increment, never above the leader's max
- **Anti-sniping** extends the end (capped); the server's clock decides every time question
- Exactly-once close from many possible triggers; hidden reserve means unsold below it
- Winner's order is requested once. Non-payment triggers a one-time second-chance offer to the runner-up, then the unit returns to stock
- Shill guard: the selling shop's members can't bid, re-checked at award. Bid history is append-only, partitioned by month

→ Spec: [S21](specs/domains/S21-limited-drops/spec.md) · Where code differs: [S21](specs/domains/S21-limited-drops/gaps.md) · [First-pass code](packages/backend/libs/domains/auctions)

### Rate limiting that works across a fleet

- Three algorithms (token bucket, sliding window, concurrency limiter), each atomic with a single time source and a TTL on every key
- Hot keys take a **leased local budget**, with a denial memo and single-flight refill
- Fail-open or fail-closed per endpoint; store timeout, breaker and in-process fallback limiter
- Failure-only counting, cost-weighted requests and penalties. Subjects can be IP, user, API key, shop or hashed email
- Policies are declared and validated at startup. The edge worker uses the same sliding window; the second limiter is removed so one engine remains

→ Spec: [S50](specs/domains/S50-rate-limiter/spec.md) · Where code differs: [S50](specs/domains/S50-rate-limiter/gaps.md) · [First-pass code](packages/backend/libs/infrastructure/rate-limit)

### Background jobs that run exactly once

- Claim with `SKIP LOCKED`, lease, heartbeat, completion fenced by lock owner. Reaper recovers expired leases
- Retries with jitter, `DEAD` after N, non-retryable failures. Operator service for stats, retry and cancel
- Cron: leader-elected single-run materialisation, time-zone-aware next fire, DST-safe, missed-fire and overlap policy
- Per-shop fairness at claim time, so one tenant can't starve the rest
- Daily partitions created ahead and dropped when finished

→ Spec: [S49](specs/domains/S49-job-scheduler/spec.md) · Where code differs: [S49](specs/domains/S49-job-scheduler/gaps.md) · [First-pass code](packages/backend/libs/infrastructure/jobs)

### A cache that survives viral traffic

*L1 + L2 · stampede protection · versioned invalidation*

- Two levels (in-process and shared), single-flight within a process, a cross-process lock, **XFetch** early refresh, SWR with stale-if-error
- Avalanche, penetration and hot/big-key protection: jittered TTL, negative entries, Bloom filter, hot-key promotion, size caps
- **Versioned invalidation**: duplicate, out-of-order and racing events can't resurrect old data
- Store down → bounded waits, breaker, loader bulkhead, correct answers
- Write-behind counters with crash-safe claim and commit. Locks with **fencing tokens** for correctness-critical use
- Correct ETag handling: lists, weak validators, `*`, and `304`s that keep validators

→ Spec: [S52](specs/domains/S52-cache-toolkit/spec.md) · Where code differs: [S52](specs/domains/S52-cache-toolkit/gaps.md) · [First-pass code](packages/backend/libs/infrastructure/cache)

---

## Platform & security

### Multi-tenant SaaS that cannot leak data

- A shop is the tenant. Tenant resolved once per request; Postgres **FORCE RLS** keyed by a transaction-scoped tenant (PgBouncer-safe) is the backstop
- Non-members get `404`, not `403`. "A shop always keeps an owner" holds under concurrency (`SERIALIZABLE` + retry)
- Single-use signed invites, per-shop enterprise SSO, and a directory mapping each shop to a cell and region
- Noisy-neighbour limits. Schema changes on live tables via expand/contract with `CONCURRENTLY` indexes and batched backfills
- **Offboarding**: export, grace period, hard delete, and an event that tells every other domain to delete theirs

→ Spec: [S03](specs/domains/S03-shops-rbac/spec.md) · Where code differs: [S03](specs/domains/S03-shops-rbac/gaps.md) · [First-pass code](packages/backend/libs/domains/tenancy)

### Auth that survives a security review

- Short-lived access tokens; opaque refresh tokens with rotation. **Reuse of an old token revokes the session**
- Cookies (`HttpOnly`, CSRF defence) for browsers, response body for non-browser clients. JWKS with key rotation. Audience-scoped service-to-service tokens
- Brute-force protection, Argon2id, uniform responses that don't reveal which emails exist, envelope encryption of stored secrets
- TOTP with replay protection and single-use recovery codes; a fresh code to change the factor
- Google OIDC with PKCE, state, nonce, a browser-bound flow. Linking only on a verified email, hardened against pre-hijacking
- A registry seam through which tenancy supplies per-shop enterprise IdPs

→ Spec: [S01](specs/domains/S01-auth-sessions/spec.md), [S02](specs/domains/S02-mfa-oidc/spec.md) · Where code differs: [S01](specs/domains/S01-auth-sessions/gaps.md), [S02](specs/domains/S02-mfa-oidc/gaps.md) · [First-pass code](packages/backend/libs/domains/identity)

### A public API sellers can build on

- API keys: shown once, only a keyed hash stored, revoked keys refused at once. The shop comes **only from the key**; another shop's record is `404`
- Sandbox: test keys act on an isolated shadow shop. Nothing is visible to live keys or billed
- **Date-pinned versions**: one implementation, with transformers upgrading requests and downgrading responses
- `Deprecation`/`Sunset`/`Link` headers, per-key usage telemetry, scheduled brownouts, `410 Gone` after sunset
- `Idempotency-Key`, per-key rate limit, monthly quota. Batch of up to 50 ops, each with its own scope check and result
- Request logs searchable by request ID for 30 days; OWASP API Top 10 mapping

→ Spec: [S42](specs/domains/S42-public-api/spec.md) · Where code differs: [S42](specs/domains/S42-public-api/gaps.md) · [First-pass code](packages/backend/libs/domains/developer-platform)

### Webhooks receivers can trust

- Per-endpoint ordered lane with one delivery in flight, so **one shop's dead server never delays another**
- Timestamped signature; **two secrets valid during rotation**; a published reference verifier
- SSRF defence: address checked when saved **and on every attempt**, and the request goes only to the address that passed
- At-least-once with retries for ~3.5 days, per-endpoint breaker, auto-disable after 3 days of failure with an owner-alert event
- Attempts logged 30 days. Replay sends the byte-identical stored body. Payloads pinned to an API version per endpoint

→ Spec: [S43](specs/domains/S43-webhooks/spec.md) · Where code differs: [S43](specs/domains/S43-webhooks/gaps.md) · [First-pass code](packages/backend/libs/domains/developer-platform)

### An embeddable checkout widget

- A copied site key is useless elsewhere: each key is bound to exact origins, and other origins get nothing, not even the shop's name
- Only registered origins may frame the checkout; every other page is `frame-ancestors 'none'`. Strict CSP with a fresh nonce per response
- Identity hand-off: the shop's backend signs a short-lived single-use token; we exchange it for an in-memory widget session. No cookies, no account linking
- Kill switch makes the button vanish, checkout refuse and sessions stop, without a deploy. Suspended or deleted shops switch off automatically
- Loader is tiny and async, and every failure renders nothing

→ Spec: [S44](specs/domains/S44-storefront-widget/spec.md) · Where code differs: [S44](specs/domains/S44-storefront-widget/gaps.md) · [First-pass code](packages/backend/libs/domains/developer-platform)

### Run customers' code without getting owned

- Seller JavaScript runs in a sealed runtime: no network, files, clock or randomness; hard memory and time caps. `node:vm` is not a sandbox
- Submit a version with test cases; a judge runs every case. Only an **all-pass** version goes live, a failing one keeps the previous active, and rollback is supported
- Checkout gives each function 5 ms and gets back **one integer discount per shop**, clamped to that shop's gross
- Timeout, crash, invalid output, missing entitlement or open breaker all mean no discount, so the buyer pays the catalogue price
- The judge runs as a hardened separate deployable: no egress, read-only filesystem

→ Spec: [S45](specs/domains/S45-discount-functions/spec.md) · Where code differs: [S45](specs/domains/S45-discount-functions/gaps.md) · [First-pass code](packages/backend/libs/domains/shop-functions)

### Serverless workers that retry correctly

- Report only the failed records of a batch. On FIFO queues a failure also fails the rest of that **message group**, keeping order, and a poison message blocks only its group
- Idempotency records turn at-least-once delivery into exactly-once effects
- One manifest is the source of truth for queue config, bundling, local run and infra
- A local runner stands in for the Lambda service and SQS event source. Dead-letter handlers and redrive

→ Spec: [S55](specs/domains/S55-serverless-workers/spec.md) · Where code differs: [S55](specs/domains/S55-serverless-workers/gaps.md) · [First-pass code](packages/backend/apps/lambdas)

### Notifications that respect people and providers

- Each notification is created **at most once** per (source event, recipient, channel), rendered once per recipient in their language
- Preferences per category and channel, mandatory notices, SMS opt-in. **DST-safe quiet hours** in the recipient's time zone; stale notifications are dropped instead of arriving late
- Marketing frequency caps. Per-channel delivery lines (bulkheads), so a campaign or provider outage never delays transactional mail
- Provider failover behind breakers. Bounces, complaints, STOP and dead tokens suppress the address; signed provider callbacks update a delivery timeline that never regresses
- 180-day inbox with unread counter and live push

→ Spec: [S28](specs/domains/S28-notifications/spec.md) · Where code differs: [S28](specs/domains/S28-notifications/gaps.md) · [First-pass code](packages/backend/libs/domains/notifications)

### One platform toolkit under every service

- RFC 9457 problem+json with a registry of stable codes. Request context across HTTP, consumers and jobs
- Transaction scope with `afterCommit` hooks, serializable retry, per-transaction timeouts and a **"no network inside a transaction"** guard
- Liveness/readiness/startup probes, ordered graceful shutdown, fail-fast startup on bad config
- Event-loop monitoring and priority-aware load shedding. Resilient HTTP client with retry budgets, breakers, bulkheads and SSRF-safe requests
- One `Idempotency-Key` facility, structured logs with redaction, an injectable clock

→ Spec: [S54](specs/domains/S54-platform-toolkit/spec.md) · Where code differs: [S54](specs/domains/S54-platform-toolkit/gaps.md) · [First-pass code](packages/backend/libs/infrastructure/platform)

### A BFF that degrades instead of failing

- One product-page aggregate endpoint with per-section time budgets, partial results, a stable error envelope, concurrency bounds and request coalescing
- GraphQL, read-only, with per-request DataLoaders, cost and depth limits, persisted documents and cost-based rate limiting
- Browser sessions: tokens held server-side, cookies, CSRF and origin checks, refresh single-flight
- Every upstream answer is validated against a published contract schema

→ Spec: [S48](specs/domains/S48-bff/spec.md) · Where code differs: [S48](specs/domains/S48-bff/gaps.md) · [First-pass code](packages/backend/libs/composition/bff)

---

## Data pipelines & search

### Import a 5 GB catalog without running out of memory

- The file goes straight to object storage in parallel, resumable parts; the API never carries the bytes
- Malware scan and content sniffing before any row is read. Streaming parse in constant memory with backpressure
- Rows validated one by one and written in batches **through the catalog's exported command**, never to its table
- Job state machine with checkpoints, resume after a crash, single-runner leases and per-shop fairness
- Live progress; one downloadable CSV of refused rows

→ Spec: [S07](specs/domains/S07-bulk-import/spec.md) · Where code differs: [S07](specs/domains/S07-bulk-import/gaps.md) · [First-pass code](packages/backend/libs/domains/catalog-sync)

### Export a million orders in constant memory

- Background build streams a server-side cursor through CSV straight into object storage, with backpressure from storage back to the database
- Correct across batch boundaries while orders change, with a deterministic order and exact money
- One active export per shop, idempotent start, lease-based claims, crash recovery, short-lived download link, retention

→ Spec: [S12](specs/domains/S12-order-export/spec.md) · Where code differs: [S12](specs/domains/S12-order-export/gaps.md) · [First-pass code](packages/backend/libs/domains/catalog-sync)

### Two-way Shopify sync without ping-pong

- Incremental pulls from a watermark with an overlap window, checkpoint per page, one runner per integration; a separate queue for backfills
- Webhooks are a fast path (signature over raw body, ack first). The scheduled pull is the guarantee
- Anti-corruption layer: payloads validated and normalised, raw kept, money parsed from decimal strings
- **Three-way stock merge** on a recorded common base, echo suppression, stale-read protection, conditional provider write, and a conflict queue
- Quarantine for malformed items; nightly reconciliation with a mass-deletion guard; fleet-wide token bucket per credential

→ Spec: [S08](specs/domains/S08-integrations/spec.md) · Where code differs: [S08](specs/domains/S08-integrations/gaps.md) · [First-pass code](packages/backend/libs/domains/catalog-sync)

### Offline devices that sync without lost sales

- Every op carries a client ID and applies exactly once however often it's sent
- Stock changes are commutative deltas (a count becomes `counted − base`), merging in any order and never below zero
- Title/price/description use per-field last-writer-wins on **hybrid logical clocks**, not device wall clocks
- Pull reads a gap-free per-shop change feed, including changes made by orders, imports and the dashboard
- Unsettleable cases (an oversold last unit) are recorded, listed and shown to a person

→ Spec: [S09](specs/domains/S09-offline-sync/spec.md) · Where code differs: [S09](specs/domains/S09-offline-sync/gaps.md) · [First-pass code](packages/backend/libs/domains/catalog-sync)

### Search reindex with zero downtime

- Search is a read model of catalog events: external versioning makes out-of-order and duplicate events harmless
- Reindex builds beside the live index from retained history, dual-writes, verifies, switches atomically and keeps the old one for rollback. Resumable, cancellable
- Versioned, validated synonym sets change results without a reindex
- Relevance measured with signed search IDs and click logs: CTR, MRR, zero-result rate
- Semantic (kNN) mode, facets, cursor paging, visibility rules, degradation; seller search runs on a separate Postgres full-text model

→ Spec: [S32](specs/domains/S32-product-search/spec.md) · Where code differs: [S32](specs/domains/S32-product-search/gaps.md) · [First-pass code](packages/backend/libs/domains/discovery)

### Autocomplete under a 40 ms budget

- Hourly offline build from the query log (popularity floor, privacy and blocklist filters) into an integrity-checked, versioned snapshot
- Every node holds a prefix → top-K index in memory and hot-swaps on a new version
- Each source has its own time budget, failure isolation and breaker; a slow source never fails the request
- Typo fallback when nothing matches. Blocklist enforced at build **and** serve time. Identical answers for every caller

→ Spec: [S33](specs/domains/S33-autocomplete/spec.md) · Where code differs: [S33](specs/domains/S33-autocomplete/gaps.md) · [First-pass code](packages/backend/libs/domains/discovery)

### "Bought together" and "Trending now"

- Recommendations: baskets from paid orders form a co-occurrence graph, trusted only with enough orders **and** enough different buyers. Cosine normalisation keeps hub products from appearing everywhere
- Nightly bounded, restartable build, with each list published atomically. A 2-hop decayed fill handles cold starts
- Trending: weighted views and add-to-carts in one-minute event-time windows with a 2-minute watermark and a correction path for late events
- Count-Min Sketch + min-heap per partition, merged exactly once. One visitor can only move a score by a bounded amount per window

→ Spec: [S34](specs/domains/S34-recommendations/spec.md), [S35](specs/domains/S35-trending/spec.md) · Where code differs: [S34](specs/domains/S34-recommendations/gaps.md), [S35](specs/domains/S35-trending/gaps.md) · [First-pass code](packages/backend/libs/domains/discovery)

### Find stock near me

- The exact store (PostGIS) is truth; the search index follows it within a stated delay. Reservation-time checks read the exact store
- "Available near me": text relevance + distance + in-stock, one result per product with its nearest point
- Map clustering in zoom-dependent cells over the viewport
- Changes reach the index in order, idempotently and replayably

→ Spec: [S19](specs/domains/S19-pickup-near-me/spec.md) · Where code differs: [S19](specs/domains/S19-pickup-near-me/gaps.md) · [First-pass code](packages/backend/libs/domains/fulfilment)

### A polite, SSRF-safe crawler

- URL frontier with one queue per host, `robots.txt` cached, `Crawl-delay` honoured, **one in-flight request per host across the fleet**, back-off on `429`/`503`
- Every request, including `robots.txt` and each redirect hop, resolves the host, requires public addresses and connects to the address that was checked
- Prices come from JSON-LD, then OpenGraph/meta, never free text. SimHash makes unchanged pages cheap
- Adaptive re-crawl interval, priority by plan and change frequency, Bloom-filter seen-set. Alerts fire when a competitor undercuts you

→ Spec: [S41](specs/domains/S41-competitor-monitor/spec.md) · Where code differs: [S41](specs/domains/S41-competitor-monitor/gaps.md) · [First-pass code](packages/backend/libs/domains/seller-insights)

### Analytics events that survive ad-blockers

- Edge collector as the primary path, backend endpoint as fallback, with identical rules, partial acceptance and fast acks
- At-least-once delivery, dedupe by event ID, event-time ordering, late and out-of-order events, malformed messages to an errors table
- `purchase` events derive server-side from paid orders, so blockers can't lose them
- Defined behaviour when the stream is unavailable

→ Spec: [S39](specs/domains/S39-analytics-ab/spec.md) · Where code differs: [S39](specs/domains/S39-analytics-ab/gaps.md) · [First-pass code](packages/backend/libs/domains/experimentation)

---

## Realtime & community

### Chat that never loses or reorders messages

- Every stored message gets a **gap-free per-channel sequence** whoever wrote it
- Idempotent send via client message ID. Live push is best-effort; **sync-after-N is the delivery guarantee**
- Unread = latest seq − last read seq. Read marking is monotonic and capped
- Presence is a 60-second heartbeat, never in the primary database
- Offline push after 30 s unread-and-offline, once per channel per 5 minutes. Exactly one event per stored message, keyed by channel
- History partitioned by month with uniqueness surviving partition boundaries

→ Spec: [S24](specs/domains/S24-product-chat/spec.md) · Where code differs: [S24](specs/domains/S24-product-chat/gaps.md) · [First-pass code](packages/backend/libs/domains/chat)

### Push to the browser with replay after reconnect

- Topic SSE with per-topic authorization, validation and limits. Topic names are checked at compile time and at startup
- `Last-Event-ID` replay from a capped stream with no gaps or duplicates
- Ref-counted fan-out across instances; behaviour defined for backplane loss and recovery
- Revocation closes open subscriptions. Heartbeats, slow-consumer drops, graceful shutdown

→ Spec: [S51](specs/domains/S51-realtime-push/spec.md) · Where code differs: [S51](specs/domains/S51-realtime-push/gaps.md) · [First-pass code](packages/backend/libs/infrastructure/realtime)

### Collaborative editing at scale

- CRDT rooms routed by a **consistent hash ring**, so each draft has one owner instance
- Permissions are checked on join **and on every update**; revocation takes effect live
- Durability through an update log, snapshots and compaction. Named versions; publish converts the draft into a product update
- Short-lived room tickets; viewers are read-only

→ Spec: [S06](specs/domains/S06-collab-editor/spec.md) · Where code differs: [S06](specs/domains/S06-collab-editor/gaps.md) · [First-pass code](packages/backend/apps/collab)

### A follow feed that survives celebrities

- Hybrid fan-out: normal accounts' items are pushed to **active** followers' timelines; celebrity items are never pushed and are merged in at read time
- Returning users get a timeline rebuilt by pulling. Timelines hold only IDs; deleted, hidden or unfollowed items are dropped when read
- Idempotent consumers with ordering, backpressure and dead-lettering

→ Spec: [S26](specs/domains/S26-follow-feed/spec.md) · Where code differs: [S26](specs/domains/S26-follow-feed/gaps.md) · [First-pass code](packages/backend/libs/domains/community)

### A live stream with thousands of comments per second

- Viewers get a bounded, fair **sample** (at most 20 comments/s in one batch per 250 ms window). Staff and the viewer's own comments are never sampled away
- Reactions are counted, not forwarded: per-second totals only
- Late joiners get the last 50 comments, the pin and the status with no gap before live updates
- Cheap synchronous moderation first, async toxicity scoring that retracts after the fact
- "Buy now — 500 left" pinned products reach every viewer through the same channel

→ Spec: [S23](specs/domains/S23-live-stream/spec.md) · Where code differs: [S23](specs/domains/S23-live-stream/gaps.md) · [First-pass code](packages/backend/libs/domains/launch-events)

### Discussion threads that stay cheap at 50,000 comments

- Top-level comments are paged, each carries its first few replies, and "load more" fetches one branch
- Votes are exact under concurrency and changeable. Ranking: **hot**, **top** and **new** for posts; Wilson lower bound for comments
- Votes from new or shadow-banned accounts have zero ranking weight; no self-votes; vote-anomaly signal
- Markdown renders through an allow-list. Raw markdown is kept and the rendition is versioned and re-checked on read

→ Spec: [S25](specs/domains/S25-discussions/spec.md) · Where code differs: [S25](specs/domains/S25-discussions/gaps.md) · [First-pass code](packages/backend/libs/domains/community)

### Same-day courier dispatch

- Couriers stream GPS in batches; the latest position lives in a per-city geo index and the full track in a durable, expiring store
- Offers go to one courier at a time with a timeout. **No courier is ever offered or assigned two deliveries**
- Durable timers survive restarts and lost messages; strict delivery state machine with history
- Per-minute surge pricing; the fee is fixed at request time
- Work is partitioned by city, and dispatcher instances own cities by consistent hashing, so one city's failure stays there

→ Spec: [S20](specs/domains/S20-courier-delivery/spec.md) · Where code differs: [S20](specs/domains/S20-courier-delivery/gaps.md) · [First-pass code](packages/backend/libs/domains/fulfilment)

---

## AI

### LLM document extraction you can put in a KYC flow

- Cheap model first, **escalate once**. Strict JSON schema output per field with confidence and evidence
- Schema validation, then hard business rules the model can't override: IBAN checksum, VAT formats, name match against the questionnaire
- Anything doubtful goes to a human reviewer, who can't approve an invalid IBAN either. Corrections become labelled eval data
- Prompt-injection containment: a hostile document can't verify a shop
- PII masked in views and sealed at rest; the same file is never extracted or billed twice; resumable processing and poison-message handling
- The verification decision is an event. Tenancy, not this capability, flips the payout flag

→ Spec: [S04](specs/domains/S04-kyc-onboarding/spec.md) · Where code differs: [S04](specs/domains/S04-kyc-onboarding/gaps.md) · [First-pass code](packages/backend/libs/domains/seller-onboarding)

### RAG where permissions live inside the query

- Document ingestion: parse, split along document structure, embed in batches, index atomically. Unchanged content is never re-processed; deleted content vanishes at once
- Hybrid retrieval, meaning and keyword, both filtered by the caller's permissions **inside** the query, then fused with reciprocal rank fusion
- A relevance floor: off-topic questions get "not found" **without a model call**
- Answers are streamed, grounded only in retrieved passages, with citations naming passage, document, heading and page
- Changing the embedding model re-indexes without mixing models. A golden-question harness measures recall and rank

→ Spec: [S47](specs/domains/S47-rag-help-center/spec.md) · Where code differs: [S47](specs/domains/S47-rag-help-center/gaps.md) · [First-pass code](packages/backend/libs/domains/assistant)

### A streaming LLM assistant with tools

- The reply is generated server-side and **survives a dropped connection**; reconnects continue without gaps or duplicates
- Read-only tools only, and the assistant never acts for the shopper. One reply at a time per user
- Per-user rate, monthly token allowance, fleet-wide provider budget, fallback model, a breaker per model
- Frozen prompt and an append-only transcript for cache-friendliness; compaction into one summary
- Input and output moderation; one durable metering record per model call, consumed by billing

→ Spec: [S46](specs/domains/S46-shopping-assistant/spec.md) · Where code differs: [S46](specs/domains/S46-shopping-assistant/gaps.md) · [First-pass code](packages/backend/libs/domains/assistant)

---

## Media, content & experiments

### Photos: from upload to safe, served images

- The API never sees the bytes: a signed upload permission with hard limits and quotas, or storage announces the object itself
- Pipeline: format decided from the bytes, size and pixel limits, malware scan, EXIF/location removed, three WebP sizes as content-addressed immutable outputs
- Idempotent, lease-protected, bounded-retry worker; status machine with history
- Near-duplicate detection across shops as a private trust-and-safety signal
- Originals are never served, only derived images from a separate media origin with `nosniff`

→ Spec: [S29](specs/domains/S29-photos/spec.md) · Where code differs: [S29](specs/domains/S29-photos/gaps.md) · [First-pass code](packages/backend/libs/domains/media)

### Video pipeline as a DAG

- Resumable upload for very large files. Inspect → quality ladder (240p–1080p, never enlarged), poster and scrub sprite in parallel → HLS package → publish
- Parallel tasks with retries, timeouts, killing stuck child processes, and exactly-once effects under duplicate deliveries
- Public videos on a stable address; unlisted videos behind a share token and a time-limited credential. The original is never served

→ Spec: [S30](specs/domains/S30-video/spec.md) · Where code differs: [S30](specs/domains/S30-video/gaps.md) · [First-pass code](packages/backend/libs/domains/media)

### Dropbox-style file sync, dedupe and digital delivery

- Content-defined chunks stored once per shop, so a file version is an ordered list of hashes and uploads send only missing chunks with integrity-checked permissions
- A stale save becomes a **conflicted copy**, never a lost update. Gapless per-shop change journal for devices
- Garbage collection with reference counts and a grace period, covering races with upload and commit
- Expiring, download-capped share links with atomic redemption
- A paid order grants a download entitlement via a short-lived buyer-bound link; a refund revokes it

→ Spec: [S31](specs/domains/S31-assets-digital-delivery/spec.md) · Where code differs: [S31](specs/domains/S31-assets-digital-delivery/gaps.md) · [First-pass code](packages/backend/libs/domains/asset-library)

### A CMS for brand stories behind a CDN

- Rich blocks are sanitised on write, so a compromised brand account can't inject script into the storefront
- Publishing freezes all locale drafts into one **immutable numbered version**, now or at a future reveal time; restore is a republish
- Public reads behind a CDN with ETags, locale fallback chain and `hreflang`. Invalidation by cache tag: origin model, CDN purge and a signed revalidation call
- Signed short-lived preview of drafts that bypasses every cache; streamed sitemap index for millions of URLs

→ Spec: [S27](specs/domains/S27-brand-stories/spec.md) · Where code differs: [S27](specs/domains/S27-brand-stories/gaps.md) · [First-pass code](packages/backend/libs/domains/content)

### Feature flags with no network call per check

- Evaluation is a pure in-memory function in every process; stores down means last known rules keep serving
- Ordered targeting rules and weighted rollouts that are **sticky and widening-only**
- Propagation by push, with a polling fallback and repair; optimistic concurrency on edits
- Kill switch, append-only audit history, and a stale-flag report because flags are tech debt
- A route gate makes a route look absent while its flag is off; browsers get only pre-evaluated flags, never the rules

→ Spec: [S38](specs/domains/S38-feature-flags/spec.md) · Where code differs: [S38](specs/domains/S38-feature-flags/gaps.md) · [First-pass code](packages/backend/libs/domains/experimentation)

### A/B tests you can trust

- Deterministic, stateless, sticky assignment, independent between experiments and exclusive inside a layer
- Exposure is logged when the user actually sees the variant, and conversions count only after exposure
- Two-proportion significance plus a **sample ratio mismatch** check, with a trust verdict
- Assignment degrades to control. Fixed-horizon analysis, stated as such

→ Spec: [S39](specs/domains/S39-analytics-ab/spec.md) · Where code differs: [S39](specs/domains/S39-analytics-ab/gaps.md) · [First-pass code](packages/backend/libs/domains/experimentation)

### Seller leaderboards and a live sales dashboard

- Weekly/monthly top sellers, overall and per category, with deterministic tie-breaking, "my rank" with percentile, and frozen period snapshots
- Feeds are idempotent, concurrent-safe, out-of-order-safe and rebuildable by replay
- Live dashboard pushes per-second counters over a realtime channel once per second, with checkout conversion and a "today so far" series
- Seller stats: summary, daily series, top products, refunds

→ Spec: [S40](specs/domains/S40-leaderboards-dashboard/spec.md) · Where code differs: [S40](specs/domains/S40-leaderboards-dashboard/gaps.md) · [First-pass code](packages/backend/libs/domains/seller-insights)

### Short and affiliate links

- Generated codes are unguessable and fixed-length (keyed Feistel bijection over base62), so there are no collision checks; custom aliases supported
- Only marketplace pages are valid destinations, which prevents open redirects
- The `302` carries the attribution reference; the edge worker serves hot codes without touching the origin and records the click itself
- Per-owner limits, idempotent creation, click statistics

→ Spec: [S37](specs/domains/S37-share-links/spec.md) · Where code differs: [S37](specs/domains/S37-share-links/gaps.md) · [First-pass code](packages/backend/libs/domains/marketing)

---

# Stack and quickstart

<div align="center">
  <img src="https://img.shields.io/badge/Cloudflare-F38020?style=for-the-badge&logo=Cloudflare&logoColor=white" alt="Cloudflare" />
  <img src="https://img.shields.io/badge/nestjs-E0234E?style=for-the-badge&logo=nestjs&logoColor=white" alt="NestJS" />
  <img src="https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Kafka_(Redpanda)-231F20?style=for-the-badge&logo=apachekafka&logoColor=white" alt="Kafka" />
  <img src="https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white" alt="Redis" />
  <img src="https://img.shields.io/badge/Stripe-008CDD?style=for-the-badge&logo=stripe&logoColor=white" alt="Stripe" />
  <img src="https://img.shields.io/badge/Elasticsearch-005571?style=for-the-badge&logo=elasticsearch&logoColor=white" alt="Elasticsearch" />
  <img src="https://img.shields.io/badge/ClickHouse-FFCC01?style=for-the-badge&logo=clickhouse&logoColor=black" alt="ClickHouse" />
  <img src="https://img.shields.io/badge/OpenTelemetry-000000?style=for-the-badge&logo=opentelemetry&logoColor=white" alt="OpenTelemetry" />
  <img src="https://img.shields.io/badge/k6-7D64FF?style=for-the-badge&logo=k6&logoColor=white" alt="k6" />
  <img src="https://img.shields.io/badge/WebSocket-4A4A55?style=for-the-badge&logo=websocket&logoColor=white" alt="WebSocket" />
</div>

# Quickstart

```bash
cd backend

# 1. Infra (Postgres, PgBouncer, Redis, Redpanda, Jaeger)
pnpm install && && pnpm infra:setup
pnpm docker

# 2. Depending on the case you want to run, execute this command with a param
pnpm run dev --use-case-1

# 2b. Read-model projections (search index, ...) run in their own app since F-05
pnpm start:dev:projector
```

**Load tests:** four k6 flows (payment, search, seller stats, chat), each with
its own 100k-user seeder. See
[`packages/backend/scripts/load-tests/README.md`](packages/backend/scripts/load-tests/README.md).

| Service                            | Port            |
| ---------------------------------- | --------------- |
| Edge Worker                        | `8787`          |
| Nest API                           | `8000`          |
| PgBouncer → Postgres               | `6432` / `5300` |
| Kafka / Pandaproxy                 | `9092` / `8082` |
| Redis HTTP (edge)                  | `8079`          |
| Elasticsearch                      | `9200`          |
| ClickHouse HTTP                    | `8123`          |
| Jaeger UI                          | `16686`         |
| MinIO (S3) / console               | `9100` / `9101` |
| ElasticMQ (SQS) / UI               | `9324` / `9325` |
| DynamoDB Local                     | `8100`          |
| ScyllaDB (CQL)                     | `9042`          |
| Mailpit SMTP / UI                  | `1025` / `8025` |
| ClamAV                             | `3310`          |
| Debezium Connect (`--profile cdc`) | `8083`          |
