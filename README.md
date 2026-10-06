<div align="center">
  <h1>Marketplace: a distributed-systems showcase</h1>
  <p><i>NestJS · Next.js · PostgreSQL · Kafka (Redpanda) · Redis · Stripe · ClickHouse</i></p>
</div>

---

# 🚀 Enterprise Architecture Showcase

Welcome to the laboratory. This is not a standard CRUD application—it is a **battle-tested showcase of distributed systems design, fault tolerance, and high-concurrency patterns.**

If you want to see how production-grade code, edge-case failure handling and architectural trade-offs look in practice, you are in the right place. Dive into the code or check out the feature showcases below to see how I build systems designed to scale.

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
       ".agents/", ".specify/", ".claude/", ".moon/", ".github/", ".aider",
       "infra/", "packages/", "scripts/"
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
   .nav-folder:has(> .nav-folder-title[data-path="scripts"]) { display: none; }
   ```

   The code stays on disk and in git; it is only out of the vault's index, graph and sidebar.

3. Links to code (`.ts` files) are not notes, so Obsidian hands them to your system's default app. To open them in the
   editor window that already has this repo open, make the editor the default for those file types. On Linux the
   catch is that the system classifies `.ts` as a Qt translation file (`text/vnd.trolltech.linguist`) and `.tsx` as
   `application/x-tiled-tsx`, so setting `text/x-typescript` does nothing (check with `gio info <file> | grep -i type`):
   `xdg-mime default cursor.desktop text/vnd.trolltech.linguist application/x-tiled-tsx text/x-typescript`.
   Line anchors (`#L19`) are ignored that way.

Folders in the vault:

| Folder | Owner | Notes |
|---|---|---|
| `docs/humans/` | the docs generator | Rewritten on every run. Do not hand-edit; any other `.md` file in it is deleted. |
| `interview-prep/` | you | Hand-written theory notes. `interview-prep/my-practice/` is gitignored (private exercises). |
| `docs/architecture/`, `docs/runbooks/`, `specs/` | you / the SDD scripts | Hand-written or agent-written, committed. |

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
- **Theory links:** `pnpm docs:theory` adds an **In this codebase** block under every section of the notes in `interview-prep/` (any heading depth). Each link is Ctrl+clickable and lands on the exact function (`file.ts#L21`); when a topic page exists for that code, it is linked next to it. Code is always linked, topic pages only if they have been generated. It writes only inside `<!-- theory-links:start/end -->` markers, so your text is never changed, and it never reads `interview-prep/my-practice/`. `docs/humans/theory-coverage.md` shows the gaps in both directions.

  The cheap path (no topic pages needed), once the code you want linked exists:

  ```sh
  pnpm docs:generate --level file   # summaries of every file and its exported functions (small Haiku calls, ~800 for this repo)
  pnpm docs:theory                  # ~45 calls: link every note section to the code that implements it
  git diff interview-prep           # review: the model's one-sentence "how" lines are the part to read critically
  ```

  After a reimplementation, run the same two commands again: only changed files and only notes whose candidates changed are redone. Generate topic pages later (`pnpm docs:generate --unit ...`) for the units you want to study; the next `pnpm docs:theory` then adds the topic links next to the code links.
- **Depth:** a topic page splits itself into sub-topics until pieces are self-explanatory. Tune `maxConceptDepth`
  (default 4) and `maxConceptsPerUnit` (default 40) in `scripts/docs/docs.config.json`.

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
- To use a separate Claude Code profile, set `CLAUDE_CONFIG_DIR=<dir>` for these scripts. Long runs:
  `systemd-inhibit --what=sleep:idle` inside `tmux`, as in the runbook.

---

## ⚙️ The Engine Room

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
  <img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/WebSocket-4A4A55?style=for-the-badge&logo=websocket&logoColor=white" alt="WebSocket" />
</div>

<br>

> **💡 Quick Navigation:** Not sure where to start? Check out the **[1-Minute Overview Video](#overview)** or jump straight into the **[Payments Platform](#cat-payments)**.

---

# TODO

First batch:

- 🚦 20. Distributed Rate Limiting
- 🦬 21. Cache Stampede Prevention
- 📥 22. Write-Behind (Write-Back) Caching

- 🧪 25. Checkout Funnel Analytics (ClickHouse `windowFunnel`)
- 🎲 26. Unique Payers at Scale (HyperLogLog / `uniqCombined`)
- ⏱️ 27. FX Rate Alignment (ClickHouse `ASOF JOIN`)
- 📡 28. Streaming Aggregates (Kafka → ClickHouse Materialized Views)

Later:

- 🕸️ 18. Graph/Network Recommendations
- 🚀 12. End-to-End Type Safety & Contract Testing
- 🗄️ 11. Database Table Partitioning (Time-Series)
- ⏳ 23. Stale-While-Revalidate (SWR) Caching
- 📡 24. Real-Time Push (Server-Sent Events / SSE)

---

# Ideas

New ideas for the future:

- Code generator 6-digit without repetitions
- Groundcover logs search, how it's implemented
- Localisation
- feature flags, A/B testing
- continuous deploys
- notifications
- rbac system for merchant and user accounts, OAuth
- Immutable audit logging to track all entity state changes for strict financial and security compliance.
- Active Directory (AD) or SAML-based Enterprise SSO integration for corporate identity management.
- Master Data Management (MDM) architecture to maintain a single source of truth for core business entities across all microservices.
- Multi-region active-active database deployment to handle global traffic and cross-border latency.
- Advanced Order Management System (OMS) state-machine with multi-warehouse geospatial inventory allocation.
- Internal B2B billing engine for cross-department chargebacks and automated automated ledger reconciliation.
- Telephony (CTI) and SMS integration for real-time transactional alerts and customer support routing.

# 📑 Index

1. [1-Minute Overview](#overview)
2. [Quickstart](#quickstart)
3. [System Use Cases & Feature Showcases](#showcases)
   - [Payments Platform & Reliability](#cat-payments)
     - [1. Fault Tolerance — Outbox Under Chaos](#s1)
     - [2. Load Test + Observability (k6 × OTEL)](#s2)
     - [3. Idempotency Under Blast](#s3)
     - [4. Double-Entry Ledger Invariants](#s4)
     - [5. Async Command Path (Write ≠ Read)](#s5)
     - [6. Optimistic Concurrency Control (OCC)](#s6)
     - [7. CQRS](#s7)
     - [8. Distributed Saga](#s8)
     - [9. Circuit Breaker](#s9)
     - [10. Cursor-Based Pagination](#s10)
     - [11. Database Table Partitioning](#s11)
     - [12. End-to-End Type Safety & Contracts](#s12)
   - [Search & Discovery](#cat-search)
     - [13. Fuzzy Search](#s13)
     - [14. Relevance Scoring (BM25)](#s14)
     - [15. Autocomplete](#s15)
     - [16. Range Filtering & Faceting](#s16)
     - [17. Semantic Vector Search (k-NN)](#s17)
     - [18. Graph Recommendations](#s18)
   - [Edge Gateway & Caching](#cat-edge)
     - [19. Edge Ingress — Auth Before the Hot Path](#s19)
     - [20. Distributed Rate Limiting](#s20)
     - [21. Cache Stampede Prevention](#s21)
     - [22. Write-Behind Caching](#s22)
   - [Realtime Client Experience](#cat-client)
     - [23. Stale-While-Revalidate (SWR)](#s23)
     - [24. Real-Time Push (SSE)](#s24)
   - [ClickHouse Analytics](#cat-analytics)
     - [25. Checkout Funnel (`windowFunnel`)](#s25)
     - [26. Unique Payers (HyperLogLog)](#s26)
     - [27. FX Rate Alignment (`ASOF JOIN`)](#s27)
     - [28. Streaming Aggregates (Kafka → MV)](#s28)
   - [Realtime Chat & WebSocket Gateway](#cat-chat)
     - [29. Polyglot Realtime Gateway (NestJS ↔ Rust Handoff)](#s29)
     - [30. Ref-Counted Cross-Instance Fan-Out (Redis Backplane)](#s30)
     - [31. Instant Moderation Enforcement (Cache Eviction over Pub/Sub)](#s31)
     - [32. Scoped, Short-Lived WebSocket Tickets](#s32)

---

<a id="overview"></a>

# 1-Minute Overview

_(Split-screen: k6 blasting the edge API · Jaeger / lag metrics · chaos kill of Kafka mid-flight with recovery)_

[Watch Architecture Walkthrough & Stress Test](link_to_video)

<a id="quickstart"></a>

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

# 3. Chat WebSocket gateway (separate Rust binary - see packages/hft-platform/README.md)
cd ../hft-platform && cargo run

# 4. (Optional) Go payment processor - drop-in replacement for payment-processor
cd ../payments && go mod tidy && go run ./cmd/main.go
```

**Load tests:** four k6 flows (payment, search, seller stats, chat), each with
its own 100k-user seeder. See
[`packages/backend/scripts/load-tests/README.md`](packages/backend/scripts/load-tests/README.md).

| Service                            | Port            |
| ---------------------------------- | --------------- |
| Edge Worker                        | `8787`          |
| Nest API                           | `8000`          |
| Chat Gateway (Rust)                | `8090`          |
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

<a id="showcases"></a>

# System Use Cases & Feature Showcases

This section showcases the system-design patterns implemented in the project.

<a id="cat-payments"></a>

## Payments Platform & Reliability

Transactional money path: Postgres + Kafka + Stripe. Correctness under failure, concurrency, and scale.

<a id="s1"></a>

### 🛡️ 1. Fault Tolerance — Outbox Under Chaos

**Business Description:** Guarantees zero data loss during infrastructure outages by decoupling database state updates from message broker events, ensuring in-flight transactions recover safely without silent drops.

**Variants:** Shown here handling network partition during payment processing, but also used for reliable transactional email delivery, cross-microservice state sync, or order fulfillment pipelines.

- **Patterns:** Transactional Outbox Pattern, Dead Letter Queue (DLQ), Exponential Backoff with Jitter, Change Data Capture (CDC).
- **Pros:** Total data consistency across distributed boundaries; immune to message broker downtime.
- **Cons:** Requires background polling worker or CDC log scraping; introduces slight processing latency; potential duplicate delivery (requires idempotent consumers).

`[Video Stub]`

<a id="s2"></a>

### 📊 2. Load Test + Observability (k6 × OTEL)

**Business Description:** Provides full end-to-end visibility into latency bottlenecks, queue backpressure, and database resource limits under extreme synthetic traffic spikes.

**Variants:** Shown here profiling high-RPS payment ingestion and Kafka consumer lag, but also used for Black Friday load readiness, microservice SLA tracking, or API gateway bottleneck analysis.

- **Patterns:** Distributed Tracing (W3C Trace Context / OpenTelemetry), Load Injection Profiling, RED/USE Metrics Framework, Consumer Lag Monitoring.
- **Pros:** Identifies performance limits and hidden race conditions before live users do; quantifies p99 latency guarantees.
- **Cons:** Significant CPU and storage overhead for full span sampling; high implementation effort to propagate trace context across async boundaries.

`[Video Stub]`

<a id="s3"></a>

### 🔁 3. Idempotency Under Blast

**Business Description:** Collapses thousands of identical or duplicate request retries into a single execution, preventing double-charging customers or creating duplicate database records under spotty network conditions.

**Variants:** Shown here as high-concurrency payment retry defense, but also used for double-click form submission prevention, automated subscription renewals, or webhook delivery handling.

- **Patterns:** Idempotency Key Pattern, Redis Distributed Lock (`SET NX`), Database Unique Constraints (`ON CONFLICT DO NOTHING`), Downstream Provider Idempotency Keys.
- **Pros:** Prevents catastrophic double-execution bugs; safely handles client-side network retries without complex client logic.
- **Cons:** Memory overhead to store idempotency keys in cache; requires strict client discipline to generate and pass unique keys correctly.

`[Video Stub]`

<a id="s4"></a>

### 📒 4. Double-Entry Ledger Invariants

**Business Description:** Enforces strict financial accounting where money cannot be created or destroyed out of thin air, asserting that every transaction mathematically sums to zero across all debits and credits.

**Variants:** Shown here as marketplace split-payments (buyer debit, merchant credit, platform fee), but fundamental to banking engines, multi-currency crypto wallets, or warehouse inventory tracking.

- **Patterns:** Double-Entry Bookkeeping, ACID Transactions, Invariant Assertion Checks, Append-Only Immutable Logs.
- **Pros:** Perfect financial auditability; mathematically eliminates phantom balance bugs or unmapped funds.
- **Cons:** High schema complexity; append-only tables grow rapidly; strict write locking can become a throughput bottleneck.

`[Video Stub]`

<a id="s5"></a>

### ⚡ 5. Async Command Path (Write ≠ Read)

**Business Description:** Decouples API response latency from slow downstream dependencies (like third-party payment gateways and database commits), instantly acknowledging user intent while work finishes in the background.

**Variants:** Shown here accepting payment requests instantly via Kafka while settling asynchronously, but also used for video/file processing pipelines, bulk email broadcasts, or complex report generation.

- **Patterns:** Asynchronous Command Handler, Event-Driven Architecture, Ingestion Decoupling, Polling / Webhook Completion Pattern.
- **Pros:** Sub-millisecond response times for client writes; absorbs massive real-time traffic surges without dropping requests or timing out.
- **Cons:** Increases client-side complexity (frontend must handle non-blocking status polling or WebSocket events to verify final settlement).

`[Video Stub]`

<a id="s6"></a>

### 🏁 6. Optimistic Concurrency Control (OCC)

**Business Description:** Prevents race conditions when thousands of users try to buy the last remaining item in stock simultaneously, without locking the entire database table.

**Variants:** Shown as inventory reservation checkout, but heavily used in collaborative document editing (Google Docs), ledger balance updates, or ticketing systems (Ticketmaster).

- **Patterns:** Versioning Columns, Compare-and-Swap (CAS), HTTP 412 Precondition Failed.
- **Pros:** High throughput for read-heavy systems; avoids deadlocks and expensive row-level locks (Pessimistic Locking).
- **Cons:** Fails under extreme write contention (many users trying to update the exact same row constantly results in high retry rates).

`[Video Stub]`

<a id="s7"></a>

### 🔀 7. CQRS (Command Query Responsibility Segregation)

**Business Description:** Physically separates the database and API endpoints used for writing data from those used for reading data, allowing the storefront to scale infinitely while complex order processing runs safely in the background.

**Variants:** Shown as separated checkout (Write) and product catalog (Read), but also powers social media feeds (read-heavy) vs. posting (write), or banking ledgers vs. statement viewing.

- **Patterns:** Event Bus (Kafka), Materialized Views, Read Projections.
- **Pros:** Independent scaling of reads vs. writes; allows optimizing the read-model (Elasticsearch) separately from the write-model (Postgres).
- **Cons:** System complexity skyrockets; forces the UI to handle eventual consistency (e.g., polling until an order appears).

`[Video Stub]`

<a id="s8"></a>

### 🎭 8. Distributed Saga (Orchestrated Transactions)

**Business Description:** Manages multi-step business workflows across independent databases without locking them. If a downstream step fails (e.g., payment succeeds, but inventory is empty), it triggers "compensating transactions" to roll back previous steps (refund the payment).

**Variants:** Shown here as a multi-step checkout (Payment → Inventory → Ledger), but critical for travel booking (Flight + Hotel), food delivery apps, or SaaS onboarding automation.

- **Patterns:** Saga Pattern, Compensating Transactions, State Machine Orchestrator, Event Choreography.
- **Pros:** Avoids catastrophic database locks (2-Phase Commit deadlocks) while maintaining eventual consistency across microservices.
- **Cons:** Massive complexity in handling edge-case failures; heavily relies on all services implementing strict Idempotency (Pattern 3).

`[Video Stub]`

<a id="s9"></a>

### 🔌 9. Circuit Breaker (Third-Party Protection)

**Business Description:** Prevents the entire application from crashing when an external dependency (like Stripe or an email service) goes down. It "trips" the circuit to fail instantly rather than making users wait 30 seconds for a timeout.

**Variants:** Shown here wrapping the Stripe payment gateway, but used for microservice-to-microservice communication, SMS delivery providers, or legacy mainframe bridging.

- **Patterns:** Circuit Breaker State Machine (Closed, Open, Half-Open), Fallback Routing, Bulkhead Pattern.
- **Pros:** Prevents connection/thread pool exhaustion; isolates failures so a downed 3rd party doesn't take down your main API.
- **Cons:** Difficult to tune the exact error thresholds and timeout windows; requires writing robust fallback business logic.

`[Video Stub]`

<a id="s10"></a>

### 📖 10. Cursor-Based Pagination (Keyset Pagination)

**Business Description:** Allows users to infinitely scroll through millions of past transactions or products without the database crawling to a halt on deep pages, which happens when using standard "Page 1, 2, 3" offset pagination.

**Variants:** Shown here for infinite scrolling the user's payment history, but identical to Twitter/Instagram feeds, log file viewers, or real-time event streams.

- **Patterns:** Keyset Pagination, Seek Method, Base64 Encoded Cursors (Next/Prev tokens).
- **Pros:** Consistent $O(1)$ query time regardless of page depth; immune to "data shifting" (showing duplicate or missing items if new data is inserted while the user is scrolling).
- **Cons:** Cannot jump directly to an arbitrary page (e.g., "Go to Page 42"); requires sorting by a strictly sequential, unique index (like UUIDv7 or Snowflake IDs).

`[Video Stub]`

<a id="s11"></a>

### 🗄️ 11. Database Table Partitioning (Time-Series)

**Business Description:** Keeps the primary database lightning fast by automatically slicing massive append-only tables (like the payment ledger) into smaller, physical chunks behind the scenes (e.g., one partition per month).

**Variants:** Shown here to keep the current month's hot ledger queries fast, but critical for high-volume audit logs, IoT sensor data ingestion, or historical analytics databases.

- **Patterns:** Range Partitioning, Postgres Declarative Partitioning, Hot/Cold Data Tiering.
- **Pros:** Massive query performance boost for recent data; effortless data retention policies (dropping a partition takes milliseconds, whereas `DELETE FROM table WHERE date < X` blocks the database for hours).
- **Cons:** Schema migrations become highly complex; enforcing global unique constraints across all partitions is difficult or unsupported in many relational databases.

`[Video Stub]`

<a id="s12"></a>

### 🚀 12. End-to-End Type Safety & Contract Testing

**Business Description:** Guarantees that frontend payloads, backend validation schemas, and database migrations never drift out of sync, preventing production runtime crashes caused by unexpected type mismatches between services.

**Variants:** Shown here locking down the NestJS-to-Next.js API contract, but critical for microservices communication, public API versioning, or multi-team enterprise codebases.

- **Patterns:** Shared Zod/TypeBox Schemas, OpenAPI / Swagger Contract Generation, Consumer-Driven Contract Testing (Pact).
- **Pros:** Eliminates entire classes of silly integration bugs; enables fearless refactoring across the full stack.
- **Cons:** Shared monorepo packages increase build complexity; strict typing can occasionally slow down rapid prototyping.

`[Video Stub]`

<a id="cat-search"></a>

## Search & Discovery

Product catalog findability: Elasticsearch lexical search, vectors, and graph co-purchase signals.

<a id="s13"></a>

### 🔍 13. Fuzzy Search (Typo Tolerance)

**Business Description:** Gracefully handles user spelling mistakes and fat-finger errors by finding close matches based on character edit distance, ensuring minor typos don't kill the user journey.

**Variants:** Shown here as a product catalog search ("iphne" → "iphone"), but also used for CRM deduplication (matching "Jon Doe" to "John Doe"), medical record matching, or fuzzy address validation.

- **Patterns:** Levenshtein Distance, Standard N-Grams, Inverted Indexing.
- **Pros:** Massive conversion rate boost; eliminates frustrating "zero-result" dead ends.
- **Cons:** Inflates index size (if using N-Grams); higher CPU utilization on reads; can surface confusing/irrelevant results if the edit distance threshold is set too loose.

`[Video Stub]`

<a id="s14"></a>

### 🎯 14. Relevance Scoring (BM25 & Field Boosting)

**Business Description:** Ranks search results mathematically so the most meaningful matches appear first, weighting rare terms higher than common ones, and prioritizing hits in critical fields (like `title`) over secondary fields (like `description`).

**Variants:** Shown here ranking shop items, but strictly applicable to legal e-discovery (ranking by keyword density), job-board matching (core skills vs. nice-to-haves), or automated support ticket routing.

- **Patterns:** TF-IDF / BM25 Algorithm, Term Vectors, Multi-Match Query Routing.
- **Pros:** Dramatically improves UX by understanding term significance rather than just boolean matching; highly tunable via field multipliers.
- **Cons:** "Black box" to business stakeholders; requires continuous tuning/A/B testing; debugging why a specific document ranked #4 instead of #1 requires deep query profiling.

`[Video Stub]`

<a id="s15"></a>

### ⌨️ 15. Autocomplete (Typeahead & Edge N-Grams)

**Business Description:** Predicts and displays exact search results instantly as the user types, keystroke by keystroke, guiding them to known inventory before they even hit "Enter."

**Variants:** Shown as instant product suggestions, but identical architecture powers IDE code completion, address autofill, global command palettes (like Slack/Linear), or user-tagging (`@mention`) lookups.

- **Patterns:** Edge N-Grams (Write-time token expansion), Completion Suggesters, Tries / Finite State Transducers (FST).
- **Pros:** Drastically reduces user friction and spelling errors; offloads heavy fuzzy queries by guiding users to exact matches early.
- **Cons:** Massive index bloat (generating tokens for "a", "ap", "app", "appl" for every word); creates aggressive read loads (triggers an API hit on every single keystroke).

`[Video Stub]`

<a id="s16"></a>

### 🎛️ 16. Multi-Field Range Filtering & Faceting

**Business Description:** Instantly filters large datasets across multiple numeric and date ranges simultaneously (e.g., price $10-$50 AND rating > 4) while returning aggregated counts for sidebar filters.

**Variants:** Shown as e-commerce sidebar faceted navigation, but also used for real estate map bounding-box searches, financial fraud auditing, or log analysis.

- **Patterns:** BKD-Trees, Roaring Bitmaps (Bitset Intersection), Columnar Storage (Doc Values).
- **Pros:** Blazing fast for multi-dimensional range queries; avoids the write-amplification of relational B-trees.
- **Cons:** Eventual consistency (new items take ~1s to appear in filters); high memory overhead for deeply nested aggregations.

`[Video Stub]`

<a id="s17"></a>

### 🧠 17. Semantic Vector Search (k-NN)

**Business Description:** Finds related items by _meaning_ rather than exact keyword matches, allowing users to search "winter coat" and find a "cold weather jacket."

**Variants:** Shown as "Similar Products" recommendations, but identical architecture powers AI chatbot knowledge retrieval (RAG), duplicate ticket detection, or image-similarity search.

- **Patterns:** Dense Vector Embeddings, HNSW (Hierarchical Navigable Small World) Graphs, Approximate Nearest Neighbor (ANN).
- **Pros:** Captures human intent and context; zero-hit searches drop dramatically.
- **Cons:** Computationally expensive to generate embeddings; ANN sacrifices perfect accuracy for speed; difficult to explain _why_ a specific result was returned.

`[Video Stub]`

<a id="s18"></a>

### 🕸️ 18. Graph/Network Recommendations

**Business Description:** Identifies non-obvious relationships to suggest items, mapping out how different entities connect to one another in real-time.

**Variants:** Shown as "Users who bought this also bought," but identical structures power LinkedIn 2nd-degree connections, fraud ring detection, or supply chain routing.

- **Patterns:** Adjacency Lists, Disjoint Set (Union-Find) with Path Compression, Depth-First Search (DFS).
- **Pros:** Unlocks massive revenue via cross-selling; instantaneous relationship lookups compared to expensive SQL `JOIN` avalanches.
- **Cons:** Graph structures can be memory-heavy; high write complexity to keep bidirectional edges updated.

`[Video Stub]`

<a id="cat-edge"></a>

## Edge Gateway & Caching

Protect the hot path at the perimeter; keep Redis as the shared brain for limits and cache coherence.

<a id="s19"></a>

### 🚪 19. Edge Ingress — Auth Before the Hot Path

**Business Description:** Validates incoming requests, authenticates identity, and assigns trace headers at the edge, rejecting bad actor traffic before it ever consumes core application memory or database connections.

**Variants:** Shown here shielding payment creation endpoints, but also used in public SaaS API gateways, multi-tenant routing layers, or high-volume webhook receiver services.

- **Patterns:** Asymmetric Token Verification (RS256 JWT), Schema Validation (Zod/TypeBox), Edge Gateway Filter, Non-Blocking Acceptance (202 Accepted).
- **Pros:** Extremely low latency rejection of unauthorized/malicious traffic; protects downstream infrastructure from CPU spikes.
- **Cons:** Requires public key distribution and synchronization between edge and core services; validation schemas must be kept perfectly in sync.

`[Video Stub]`

<a id="s20"></a>

### 🚦 20. Distributed Rate Limiting

**Business Description:** Protects the system from DDoS attacks and API abuse by mathematically restricting how many requests a specific user or IP can make within a time window.

**Variants:** Shown as brute-force login protection, but identical logic powers SaaS freemium tier limits, webhook throttling, or scraping defense.

- **Patterns:** Token Bucket / Leaky Bucket algorithms, Redis Lua Scripting (for atomic operations).
- **Pros:** Prevents cascading system failures under load; monetizes API usage cleanly.
- **Cons:** Redis becomes a strict dependency on the hot path; clock drift between distributed nodes can cause edge-case limit breaches.

`[Video Stub]`

<a id="s21"></a>

### 🦬 21. Cache Stampede Prevention

**Business Description:** Prevents the database from melting down when a highly popular cached item (like a viral product) expires, and 10,000 requests suddenly bypass the cache and hit the database at the exact same millisecond.

**Variants:** Shown as viral product page caching, but critical for live sports leaderboards, stock market tickers, or trending news homepages.

- **Patterns:** Probabilistic Early Expiration (XFetch algorithm), Distributed Mutex / Locking (Redlock), Cache-Aside.
- **Pros:** Guarantees database stability during viral traffic spikes; ensures stable p99 latency.
- **Cons:** Increases cache logic complexity; requires tuning the probabilistic delta to match expected traffic patterns.

`[Video Stub]`

<a id="s22"></a>

### 📥 22. Write-Behind (Write-Back) Caching

**Business Description:** Absorbs massive spikes of low-value, high-frequency writes (like view counts or analytics) in memory, periodically flushing them to the database in bulk to protect disk I/O.

**Variants:** Shown here as product page view counters, but critical for social media likes, IoT sensor telemetry ingestion, or live concurrent user tracking.

- **Patterns:** Write-Behind Cache, Buffer Batching, Redis Hashes/Streams.
- **Pros:** Reduces database write load by 90%+; allows the system to survive massive sudden traffic spikes.
- **Cons:** Potential data loss if the cache node crashes before the background flush executes (durability vs. speed tradeoff).

`[Video Stub]`

<a id="cat-client"></a>

## Realtime Client Experience

How the UI stays fast and reactive without hammering the API.

<a id="s23"></a>

### ⏳ 23. Stale-While-Revalidate (SWR) Caching

**Business Description:** Guarantees sub-50ms page loads by instantly serving a slightly outdated cached response, while silently fetching the fresh data in the background to update the cache for the next user.

**Variants:** Shown here for dynamic product catalog pricing, but identical to how Next.js ISR works, CDN edge caching, or user profile metadata loading.

- **Patterns:** Cache-Control Headers, Background Refresh, Cache-Aside.
- **Pros:** Masks database and network latency entirely; provides an instant UX for read-heavy, eventually consistent data.
- **Cons:** Users briefly see old data; can cause UI jumpiness if not handled gracefully on the frontend.

`[Video Stub]`

<a id="s24"></a>

### 📡 24. Real-Time Push (Server-Sent Events / SSE)

**Business Description:** Closes the loop on asynchronous processing by pushing a notification to the client the exact millisecond a background job finishes, rather than forcing the frontend to constantly spam the server asking "Is it done yet?"

**Variants:** Shown here updating the UI when the Kafka payment command finalizes, but powers live sports scoreboards, stock market tickers, or collaborative document cursors.

- **Patterns:** Server-Sent Events (SSE) / WebSockets, Redis Pub/Sub Broadcast, Connection Multiplexing.
- **Pros:** Drastically reduces database load by eliminating HTTP polling; creates a magical, instant user experience.
- **Cons:** Load balancers often drop long-lived connections; requires maintaining stateful connection maps in a stateless backend.

`[Video Stub]`

<a id="cat-analytics"></a>

## ClickHouse Analytics

OLAP beside OLTP: funnels, approximate uniques, time-aligned joins, and streaming rollups — without loading Postgres.

<a id="s25"></a>

### 🧪 25. Checkout Funnel Analytics (ClickHouse `windowFunnel`)

**Business Description:** Measures conversion drop-off across the payment journey at billions of events — homepage → add-to-cart → checkout → payment succeeded — within configurable time windows, without multi-table self-joins that choke Postgres.

**Variants:** Shown here as payment checkout funnel telemetry, but identical to SaaS onboarding funnels, app install→activate→subscribe, or fraud step sequences.

- **Patterns:** ClickHouse `windowFunnel`, Columnar Event Streams, OLAP Separation from OLTP.
- **Pros:** Sequential funnel queries stay milliseconds-fast at huge scale; Postgres stays free for transactional payments.
- **Cons:** Eventual consistency vs the OLTP ledger; requires a clean event taxonomy (`view`, `cart`, `checkout`, `paid`).

`[Video Stub]`

<a id="s26"></a>

### 🎲 26. Unique Payers at Scale (HyperLogLog / `uniqCombined`)

**Business Description:** Answers “how many unique payers / IPs / cards touched us this month?” across enormous event volumes without loading every distinct key into RAM — using probabilistic sketches with ~99% accuracy and tiny memory.

**Variants:** Shown here as unique successful payers per merchant, but also used for unique visitors, distinct devices, or approximate cardinality dashboards.

- **Patterns:** HyperLogLog / `uniq` / `uniqCombined`, Approximate Cardinality, Vectorized Aggregation.
- **Pros:** Stable memory footprint; safe under “COUNT DISTINCT” storms that OOM row stores.
- **Cons:** Approximate (not exact); wrong tool when finance needs a precise, auditable distinct count (use Postgres for that).

`[Video Stub]`

<a id="s27"></a>

### ⏱️ 27. FX Rate Alignment (ClickHouse `ASOF JOIN`)

**Business Description:** Attaches each payment to the most recent FX / fee quote that was valid _at or before_ the payment timestamp — even when quote and payment clocks never match exactly.

**Variants:** Shown here aligning multi-currency payment ticks to FX mid-market rates, but also used for IoT sensor ↔ control setpoints or stock trades ↔ last quote.

- **Patterns:** `ASOF JOIN`, Time-Series Alignment, Columnar Join Pipelines.
- **Pros:** Correct “as-of” economics without brittle interval SQL; built for tick-level finance data.
- **Cons:** Semantics differ from equi-joins; requires sorted/time-keyed data and careful null/gap handling.

`[Video Stub]`

<a id="s28"></a>

### 📡 28. Streaming Aggregates (Kafka → ClickHouse Materialized Views)

**Business Description:** Consumes payment/response events from Kafka and rolls them into minute/hour rollups in-flight (e.g. `SUM(amount) GROUP BY merchant, toStartOfMinute(ts)`), writing only aggregates to disk while raw events can be retained or discarded by policy.

**Variants:** Shown here as live payment volume dashboards, but also used for observability metrics, IoT rollups, or ad-impression counters.

- **Patterns:** Kafka Engine / Kafka Connect → ClickHouse, Materialized Views, Streaming Aggregation.
- **Pros:** Sub-second dashboard freshness without hammering Postgres; OLTP stays lean.
- **Cons:** MV debugging is harder than batch ETL; bad MV definitions amplify bad data forever until rebuilt.

`[Video Stub]`

<a id="cat-chat"></a>

## Realtime Chat & WebSocket Gateway

Per-product chat, split by latency profile: management/moderation in NestJS, the realtime connect/fan-out hot path in a dedicated Rust service.

<a id="s29"></a>

### 🦀 29. Polyglot Realtime Gateway (NestJS ↔ Rust Handoff)

**Business Description:** Splits chat into a slow-changing management plane (channel creation, moderation actions, message history) in NestJS and a latency-critical realtime plane (WebSocket connect, message fan-out) in a dedicated Rust service, so the hot path never pays for a GC pause or an ORM roundtrip — and one socket per client is multiplexed across every channel they're subscribed to, Discord-style, instead of one connection per channel.

**Variants:** Shown here as per-product chat channels, but the same split underlies Discord's own architecture (a separate low-level gateway vs. a REST API), high-frequency trading order-entry gateways, or multiplayer game state servers.

- **Patterns:** Polyglot Microservices, Bounded Context Splitting by Latency Profile, Single-Connection Multi-Channel Multiplexing.
- **Pros:** Each runtime does only what it's good at — NestJS's DX for CRUD/validation, Rust's near-zero-overhead concurrency for tens of thousands of held-open sockets; independent scaling and deploys.
- **Cons:** Two codebases to keep in sync (shared Redis topic names, JWT claim shapes) with no compiler-enforced contract between them; operational overhead of running and monitoring a second runtime.

`[Video Stub]`

<a id="s30"></a>

### 🕸️ 30. Ref-Counted Cross-Instance Fan-Out (Redis Backplane)

**Business Description:** Lets any number of gateway instances serve the same chat channel without every instance subscribing to every channel that exists — each instance opens a Redis subscription for a channel only while it has at least one locally-connected client in it, and tears the subscription down the moment the last local subscriber leaves.

**Variants:** Shown here for chat message/typing fan-out, but the same shape underlies any horizontally-scaled pub/sub system: multiplayer game rooms, live-collaboration cursors, or trading-venue market-data distribution.

- **Patterns:** Reference-Counted Subscription, Pub/Sub Backplane, Local Broadcast + Cross-Instance Bridge.
- **Pros:** Fan-out cost scales with actual traffic/interest rather than with the total number of channels that exist; adding gateway instances requires zero coordination between them.
- **Cons:** A brief Redis connectivity blip exactly at subscribe time can leave a receiver silently stalled until the client resubscribes; best-effort (not exactly-once) delivery if a client falls behind the local broadcast buffer.

`[Video Stub]`

<a id="s31"></a>

### 🔨 31. Instant Moderation Enforcement (Cache Eviction over Pub/Sub)

**Business Description:** Makes a ban or mute issued through the NestJS moderation API take effect on every open connection, on every gateway instance, within milliseconds — not on the next poll or the next cache TTL expiry — by pushing the moderation event over Redis and having each instance evict its local authorization cache and force-disconnect the affected user's channel subscription directly.

**Variants:** Shown here for chat bans/mutes, but the same shape is how any short-TTL authorization cache stays correct under revocation: API key revocation, feature-flag kill switches, or session invalidation across a fleet.

- **Patterns:** Cache Invalidation via Pub/Sub, Short-TTL Cache as Backstop (not the primary correctness mechanism), Direct Per-Connection Push.
- **Pros:** Revocation feels instant regardless of fleet size; the TTL only has to catch the rare missed-message case, so it can stay short without adding load.
- **Cons:** Requires a per-user connection registry on every instance; a missed pub/sub message (e.g. during a Redis failover) is silently masked by the TTL rather than surfaced.

`[Video Stub]`

<a id="s32"></a>

### 🎟️ 32. Scoped, Short-Lived WebSocket Tickets

**Business Description:** Instead of handing the browser's long-lived access token to a native `WebSocket` (which can't set custom headers, forcing the token into a URL where it risks being logged by proxies or servers), NestJS mints a purpose-scoped ticket — a JWT valid for 60 seconds, carrying a claim a normal access token doesn't have — just for opening the socket.

**Variants:** Shown here authenticating the chat gateway, but identical to pre-signed S3 upload URLs, one-time magic-link login tokens, or short-lived STS credentials.

- **Patterns:** Ticket-Based Auth Handoff, Token Scoping via Custom Claims, Time-Boxed Capability.
- **Pros:** A leaked ticket (server logs, browser history) is worthless after a minute and can't be replayed for anything but a WS upgrade; no change needed to how the native WebSocket API sends credentials.
- **Cons:** One extra request before every connection attempt; requires both runtimes to agree on the same secret and claim shape with no shared type system to enforce it.

`[Video Stub]`

<a id="adr"></a>

# ADR (Architecture Decision Records)

This section explains the core design choices across the system in a logical chain of Questions and Answers.

### Edge Gateway & Caching

**Why do you use Cloudflare?**

Because it protects against DDoS attacks and saves money.

**Why does Cloudflare save money?**

Because Cloudflare Workers use V8 isolates which are very cheap to run with instant cold starts.

**How do you draw a line of what to put into a Cloudflare worker?**

Any stateless logic (like request validation, JWT authentication, and token bucket rate limiting) goes to the edge. This stops bad actors before they consume core API resources.

You cannot put everything on the edge, since cloudflare workers are very limited in CPU time and memory. Though edge compute is evolving rapidly, it is not yet mature enough to handle the complexities of a full-fledged application.

**Why use Redis at the edge?**

To maintain a shared state for distributed rate limiting and cache stampede prevention (using Redlock) across distributed Cloudflare workers.

**Why implement a Write-Behind cache? (TODO)**

To absorb massive spikes of low-value, high-frequency writes (like view counts). For example, updating a Redis counter on every request and flushing it to Postgres in bulk every 10 seconds prevents DB disk I/O bottlenecks.

**Why use Stale-While-Revalidate (SWR) caching? (TODO)**

To guarantee sub-50ms page loads. It serves slightly outdated data instantly while silently fetching fresh data in the background, masking all network/DB latency.

### Payments Platform & Reliability

**Why do you put writes into Kafka instead of a direct DB insert?**

To handle high loads and traffic spikes gracefully, instantly acknowledging user intent while the heavy processing finishes in the background.

**Why can't your main server handle it?**

Because compute instances don't scale instantly, and database connection pools could become exhausted during a spike.

**Why do you use the Outbox pattern alongside Kafka?**

To guarantee zero data loss. For example, if we insert a `Payment` record and publish a Kafka event, but Kafka is down, the event is lost. By inserting the `Payment` and an `OutboxEvent` in the _same Postgres transaction_, we guarantee atomicity. A separate worker picks up the outbox event and publishes it reliably.

**Why implement idempotency keys?**

To safely collapse identical request retries into a single execution. For example, if a user has a spotty network and double-clicks "Pay", the key ensures the database unique constraint collapses the second request, preventing a double-charge.

**Why use double-entry bookkeeping?**

To mathematically ensure money cannot be created or destroyed. Every transaction (which corresponds to a single `Payment` record, each connected to a set of `LedgerEntry` records) requires equal debit and credit entries, keeping strict financial auditability.

**Why use Optimistic Concurrency Control (OCC) instead of pessimistic locks? (TODO)**

To avoid deadlocks and maintain high throughput. We use a version column for inventory reservation, allowing thousands of reads but rejecting concurrent writes with HTTP 412 if the version changed mid-flight.

**Why physically separate read and write databases (CQRS)? (TODO)**

So the storefront (read-heavy, Elasticsearch) can scale infinitely for complex queries without affecting order processing (write-heavy, Postgres).

**Why use a Distributed Saga instead of 2-Phase Commits? (TODO)**

To manage multi-step workflows (e.g., Payment → Inventory → Ledger) across microservices without locking remote databases. If inventory fails, a compensating transaction automatically refunds the payment.

**Why implement the Circuit Breaker pattern? (TODO)**

To protect the main API from going down when 3rd parties (like Stripe) fail. Instead of waiting 30 seconds for a timeout and exhausting connection pools, the circuit "trips" and fails instantly.

**Why use Cursor-Based Pagination? (TODO)**

Standard offset pagination (`LIMIT 10 OFFSET 100000`) crawls to a halt on deep pages. Cursors ensure consistent $O(1)$ query time regardless of page depth.

**Why use Database Table Partitioning? (TODO)**

Massive append-only tables (like ledgers) slow down over time. Slicing them into physical monthly chunks keeps recent data queries fast and makes data deletion effortless (dropping a partition).

**Why use Zod/TypeBox end-to-end? (TODO)**

To guarantee API contract safety. It ensures the frontend, backend, and DB migrations never drift out of sync, preventing silly integration bugs during refactors.

### Search & Discovery (TODO)

**Why use Elasticsearch instead of Postgres for product search?**

Because Elasticsearch natively supports fuzzy search, relevance scoring (BM25), and fast faceting which Postgres struggles with at scale.

**Why is fuzzy search important?**

It gracefully handles user spelling mistakes (edit distance), massively boosting conversion rates by preventing "zero-result" dead ends.

**Why use Edge N-Grams for Autocomplete?**

It predicts exact search results keystroke-by-keystroke, guiding users to known inventory before they even hit "Enter", offloading heavier fuzzy queries.

**Why use Semantic Vector Search (k-NN)?**

To find related items by _meaning_ rather than exact keyword matches (e.g., searching "winter coat" finds "cold weather jacket").

**Why implement Graph Recommendations?**

To map non-obvious relationships (e.g., "Users who bought X also bought Y") using instantaneous adjacency list lookups instead of expensive SQL `JOIN` avalanches.

### Observability & Analytics (TODO)

**Why use k6 with OpenTelemetry?**

To inject massive synthetic load while tracking distributed traces. It identifies queue backpressure, p99 latency guarantees, and DB limits before live users do.

**Why use ClickHouse for analytics?**

It uses columnar storage and vectorized execution, allowing for massive data aggregations and window functions without choking the transactional DB (Postgres).

**Why use the `windowFunnel` function in ClickHouse?**

To measure conversion drop-off (homepage → cart → checkout → paid) sequentially within strict time windows without slow multi-table self-joins.

**Why use HyperLogLog for unique counts?**

Because it answers "how many unique payers?" using probabilistic sketches with tiny memory overhead, preventing Out-Of-Memory (OOM) errors during COUNT DISTINCT storms.

**Why use ClickHouse `ASOF JOIN`?**

To accurately attach each payment to the most recent FX rate valid _at or before_ the transaction timestamp, which is critical for tick-level financial data alignment.

**Why stream Kafka directly into ClickHouse Materialized Views?**

To compute minute/hour rollups in-flight for sub-second dashboard freshness, writing only the aggregates to disk and bypassing Postgres entirely.

**Why use Real-Time Push (SSE)?**

To eliminate database polling. Instead of the UI asking "Is it done yet?" every second, the server pushes a message the exact millisecond a background job finishes.

### Realtime Chat & WebSocket Gateway

**Why is chat split between NestJS and a separate Rust service instead of just doing it all in NestJS?**

Because the two halves have completely different latency/resource profiles. Channel creation, moderation actions, and history reads are ordinary low-volume request/response work — NestJS is fine there. Holding tens of thousands of WebSocket connections open and fanning out messages to them is a different problem: Node's event loop and GC pauses become the bottleneck long before Rust's would. So the connect/subscribe/send hot path moved to Rust; everything else stayed in NestJS.

**Why one WebSocket connection per client instead of one per channel?**

Browsers and OS file descriptors both have real per-connection overhead. A user subscribed to 20 product chats would otherwise open 20 sockets. Instead, one socket carries `subscribe`/`unsubscribe`/`send` frames naming the channel, the same way Discord's own gateway multiplexes every server and DM a client is in over a single connection.

**How does a message sent to one gateway instance reach a client connected to a different instance?**

Through Redis pub/sub as the cross-instance backplane. The instance that receives a `send` writes the message to Postgres, then publishes it to that channel's Redis topic. Every gateway instance with a local subscriber for that channel is listening on the same topic and rebroadcasts to its own connections — including the sender's, which is what it means for the sender to see their own message the same way everyone else does, rather than getting a special-cased direct echo.

**Why does an instance only subscribe to Redis for channels it actually has a local listener for?**

To avoid a fleet of N gateway instances each paying the subscription cost of every channel that has ever existed, most of which have zero currently-connected users. Ref-counting local subscribers (via `broadcast::Sender::receiver_count()`) means Redis subscription cost tracks actual concurrent interest, not total channel count.

**Why maintain a membership cache at all if moderation actions are pushed over pub/sub?**

Because the cache is the fast path (avoids a Postgres round-trip on every single message send), and the pub/sub push is what keeps it _correct_ under revocation — the cache's short TTL is only a backstop for the rare case a gateway instance misses the eviction message (e.g. mid-reconnect to Redis), not the primary mechanism a ban relies on.

**Why not just put the browser's normal access token in the WebSocket URL?**

Because URLs get logged — by reverse proxies, browser history, server access logs — and a long-lived credential sitting in plaintext logs is a real leak surface. Minting a 60-second, purpose-scoped ticket (carrying a claim a normal access token doesn't have, so the two can't be swapped for each other) bounds the blast radius of that URL ending up somewhere it shouldn't.

## Cases that didn't make it into the code

### Sorting Boundary

I initally wanted to filter `Payment` table by `userId` inside `BisOrder` table, and add a query like this for a history of transactions:

```sql
SELECT * FROM "Payment"
  INNER JOIN "BisOrder" ON "Payment"."bisOrderId" = "BisOrder"."id"
WHERE "BisOrder"."userId" = :userId AND "Payment"."id" < :cursorId
ORDER BY "Payment"."id" DESC
LIMIT 10;
```

But I realized this is not efficient and may lead to performance issues when the `BisOrder` table grows large, so I decided to add a `userId` column to the `Payment` table and filter by `userId` directly.
