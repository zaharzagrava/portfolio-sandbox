# System Design Practice Catalog

These are practice runs for the theory in the other docs. Each design answers a prompt an interviewer might give ("how would you build X?") in the same shape: clarify → design → deep dives → trade-offs → which theory it exercises.

The list is normalized for a **web / full-stack (Node) engineer**: the classic system-design prompts (URL shortener, ticket booking, chat, ride-hailing, …) plus web-platform architectures those lists usually skip (embeddable widgets, multi-tenant SaaS, serverless, BFF, offline-first, AI apps).

## How to practice
1. Pick a prompt from the table and set a **45-minute timer** (framework and time split: `01-system-design-framework.md`).
2. Out loud or on paper: requirements with numbers → API and data model → high-level diagram → 2–3 deep dives → failure modes and observability.
3. Only then read the write-up and note what you missed.
4. Where you've built something similar, prepare a 2-minute "I've built something like this" story.

## Answer template used in every design
| Part | What to cover |
|---|---|
| **Clarify** | the questions to ask, plus the assumptions/numbers used if the interviewer leaves it open |
| **Design** | components, data model, key APIs, diagram |
| **Deep dives** | the 2–4 hard parts the interviewer will push on, the chosen approach, and the alternatives |
| **Trade-offs and pitfalls** | what you gave up and what usually goes wrong |
| **Theory** | links to the docs that explain the underlying concepts |

## Catalog

| # | Design | Core challenge | File |
|---|---|---|---|
| **Web platform architectures** ||| |
| 1 | Embeddable widget / third-party script (chat widget, comments, payments button) | isolation, cross-origin auth, cookies, performance on someone else's page | `04-web-platform-architectures.md` |
| 2 | Multi-tenant B2B SaaS | tenant isolation, RBAC, noisy neighbors, per-tenant config | `04` |
| 3 | Serverless application (Lambda + API Gateway + managed services) | cold starts, connection limits, async events, cost | `04` |
| 4 | Web app with BFF / micro-frontends | client-specific APIs, team boundaries, independent deploys | `04` |
| 5 | Content site / CMS (Jamstack, Next.js ISR) | caching layers, revalidation, SEO, i18n | `04` |
| 6 | Offline-first PWA | local storage, sync, conflict resolution | `04` |
| 7 | Public API / developer platform | API keys, versioning, rate limits, webhooks, docs | `04` |
| **Social and content** ||| |
| 8 | URL shortener (bit.ly) | ID generation, read-heavy caching, redirects | `05-social-and-content.md` |
| 9 | Twitter / news feed | fan-out on write vs read, celebrities, timelines | `05` |
| 10 | Instagram-style photo sharing | media upload pipeline + feed | `05` |
| 11 | Comments / Reddit-style voting and ranking | hot ranking, vote counting, nested threads | `05` |
| 12 | Search autocomplete / typeahead | prefix search, ranking, latency | `05` |
| 13 | Proximity search (Yelp, "near me") | geo indexing | `05` |
| **Real-time and collaboration** ||| |
| 14 | Chat app (WhatsApp / Slack) | WebSocket fleet, delivery guarantees, ordering, presence | `06-realtime-and-collaboration.md` |
| 15 | Live comments / live reactions on a stream | massive fan-out, SSE, aggregation | `06` |
| 16 | Collaborative editor (Google Docs, Figma-lite) | OT/CRDT, real-time sync | `06` |
| 17 | Notification system | multi-channel delivery, preferences, retries | `06` (+ `02` Example 4) |
| 18 | Real-time leaderboard / live dashboard | sorted sets, streaming aggregates | `06` |
| **Commerce and transactions** ||| |
| 19 | E-commerce checkout and inventory | overselling, cart, order state machine | `07-commerce-and-transactions.md` |
| 20 | Payment system / ledger | idempotency, double-entry, reconciliation | `07` (+ `02` Example 1) |
| 21 | Ticket booking (Ticketmaster) | seat holds, extreme contention, virtual queue | `07` |
| 22 | Online auction (eBay) | concurrent bids, real-time updates, ending time | `07` |
| 23 | Ride-hailing / food delivery (Uber) | location ingestion, matching, geo | `07` |
| 24 | Subscription billing (SaaS plans) | recurring charges, proration, dunning | `07` |
| **Media and files** ||| |
| 25 | File storage and sync (Dropbox / Google Drive) | chunking, dedupe, sync, sharing | `08-media-and-files.md` |
| 26 | Video streaming (YouTube / Netflix) | transcoding, adaptive bitrate, CDN | `08` |
| 27 | Large file upload and processing service | presigned/multipart upload, async pipeline | `08` |
| **Data and infrastructure** ||| |
| 28 | Rate limiter | distributed counters, algorithms | `09-data-and-infrastructure.md` (+ `02` Example 3) |
| 29 | Distributed job scheduler / background jobs | at-least-once, retries, cron at scale | `09` |
| 30 | Webhook delivery platform | retries, signing, per-endpoint isolation | `09` |
| 31 | Analytics event ingestion / A/B testing | high write volume, dedupe, aggregation | `09` (+ `02` Example 2) |
| 32 | Ad click aggregator / top-K trending | stream aggregation, windows, exactly-once counts | `09` |
| 33 | Metrics and logging platform | time series, cardinality, retention | `09` |
| 34 | Distributed cache | sharding, eviction, consistency | `09` |
| 35 | Web crawler | frontier, politeness, dedupe | `09` |
| 36 | Data sync / ETL integration platform | incremental sync, rate limits, reconciliation | `09` |
| 37 | Product search (catalog search with filters) | search index sync, facets, relevance | `09` |
| 38 | Feature flags / remote config service | low-latency evaluation, propagation | `09` |
| 39 | Authentication / SSO service | tokens, sessions, OAuth/OIDC | `09` |
| 40 | Online judge / code execution (LeetCode) | sandboxing untrusted code, queues | `09` |
| 41 | Historical / "as-of" reporting | bitemporal data, snapshots | `02` Example 5 |
| **AI applications** ||| |
| 42 | LLM chat app (ChatGPT-style) | token streaming, conversation storage, cost/rate limits | `10-ai-applications.md` |
| 43 | RAG knowledge base / "chat with your docs" | ingestion, embeddings, vector search, permissions | `10` |
| 44 | AI document-processing pipeline | queues, LLM extraction, validation, human review | `10` |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Creating and resolving share links](../../docs/humans/concepts/domain-marketing/share-short-links.md): Share-link creation and 302 redirect with click recording is one of the catalog's practice-style designs (URL shortener) implemented in the marketing domain. [`ShareLinksController`](../../packages/backend/libs/domains/marketing/api/share-links.controller.ts#L17), [`ShareLinkService`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L47)
> - [Idempotent creation of the payment row](../../docs/humans/concepts/domain-payments/idempotent-payment-insert.md): The payment row is created idempotently via INSERT ... ON CONFLICT ("idempotencyKey") DO NOTHING in executePayment, covering the payments-style catalog design. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
> - [`FeedService`](../../packages/backend/libs/domains/community/application/feed.service.ts#L43): FeedService implements a hybrid fan-out home timeline (push for normal users, pull for celebrities), matching the news-feed catalog design. _(feed.service.ts)_
<!-- theory-links:end -->

