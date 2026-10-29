# System design / architecture tasks

51 open design questions for backend-leaning Full Stack Node interviews at any company: classic designs (URL shortener, feed, chat, video, ride-hailing, ticketing, payments, AI/RAG…), everyday backend scenarios (idempotency, outbox, sagas, migrations, multi-tenancy, caching, jobs, auth, DR…) and debugging cases. Domains vary on purpose. One file per task: the question, then the model answer folded.

Bonus domain pack: [../fintech-pack/](../fintech-pack/README.md). Rehearsed webhook-ingestion design: [../01-pms-webhook-ingestion.md](../01-pms-webhook-ingestion.md).

| # | Task | Topic | Level |
|---|---|---|---|
| arch-01 | [Open banking account linking and transaction sync](arch-01-open-banking-account-linking-and-transaction-sync.md) | Integrations | Medium |
| arch-02 | [URL shortener for marketing campaigns](arch-02-url-shortener-for-marketing-campaigns.md) | Scaling | Easy |
| arch-03 | [Rate limiter service for an API gateway](arch-03-rate-limiter-service-for-an-api-gateway.md) | API Design | Easy |
| arch-04 | [News feed for a social app](arch-04-news-feed-for-a-social-app.md) | Social | Medium |
| arch-05 | [Chat app: groups, receipts, presence, offline](arch-05-chat-app-groups-receipts-presence-offline.md) | Realtime | Hard |
| arch-06 | [Appointment reminders: email, SMS, push](arch-06-appointment-reminders-email-sms-push.md) | Messaging | Medium |
| arch-07 | [Search autocomplete for an online store](arch-07-search-autocomplete-for-an-online-store.md) | Search | Easy |
| arch-08 | [File storage and sync for business teams](arch-08-file-storage-and-sync-for-business-teams.md) | Storage | Medium |
| arch-09 | [Video upload, transcoding and streaming](arch-09-video-upload-transcoding-and-streaming.md) | Media | Medium |
| arch-10 | [Ride-hailing: driver locations and matching](arch-10-ride-hailing-driver-locations-and-matching.md) | Geo | Hard |
| arch-11 | ["Restaurants near me" for a delivery marketplace](arch-11-restaurants-near-me-for-a-delivery-marketplace.md) | Geo | Easy |
| arch-12 | [Concert ticket booking with seat holds](arch-12-concert-ticket-booking-with-seat-holds.md) | Commerce | Medium |
| arch-13 | [Flash sale: checkout and inventory without overselling](arch-13-flash-sale-checkout-and-inventory-without-overselling.md) | Commerce | Hard |
| arch-14 | [Marketplace payments: PSP, 3DS, webhooks, reconciliation](arch-14-marketplace-payments-psp-3ds-webhooks-reconciliation.md) | Payments | Hard |
| arch-15 | [Double-entry ledger for a P2P wallet](arch-15-double-entry-ledger-for-a-p2p-wallet.md) | Fintech | Medium |
| arch-16 | [Real-time leaderboard for a mobile game](arch-16-real-time-leaderboard-for-a-mobile-game.md) | Gaming | Easy |
| arch-17 | [Metrics and logging platform](arch-17-metrics-and-logging-platform.md) | Observability | Medium |
| arch-18 | [Ad click aggregation and top-K trending ads](arch-18-ad-click-aggregation-and-top-k-trending-ads.md) | Streaming | Hard |
| arch-19 | [Web crawler for a job aggregator](arch-19-web-crawler-for-a-job-aggregator.md) | Data | Medium |
| arch-20 | [Distributed scheduler for millions of user-defined jobs](arch-20-distributed-scheduler-for-millions-of-user-defined-jobs.md) | Reliability | Medium |
| arch-21 | [Collaborative document editing](arch-21-collaborative-document-editing.md) | Realtime | Hard |
| arch-22 | [AI assistant: streaming answers with RAG over company docs](arch-22-ai-assistant-streaming-answers-with-rag-over-company-docs.md) | AI | Medium |
| arch-23 | [Idempotent create-order API](arch-23-idempotent-create-order-api.md) | API Design | Easy |
| arch-24 | [Outbound webhooks platform for customers](arch-24-outbound-webhooks-platform-for-customers.md) | Integrations | Medium |
| arch-25 | [Syncing from a third-party API with no webhooks](arch-25-syncing-from-a-third-party-api-with-no-webhooks.md) | Integrations | Medium |
| arch-26 | [Transactional outbox and idempotent consumers](arch-26-transactional-outbox-and-idempotent-consumers.md) | Distributed Systems | Medium |
| arch-27 | [Travel booking saga: flight, hotel and car](arch-27-travel-booking-saga-flight-hotel-and-car.md) | Distributed Systems | Medium |
| arch-28 | [Zero-downtime schema change on a 200M-row table](arch-28-zero-downtime-schema-change-on-a-200m-row-table.md) | Data | Hard |
| arch-29 | [Multi-tenant SaaS: tenant data isolation](arch-29-multi-tenant-saas-tenant-data-isolation.md) | Security | Medium |
| arch-30 | [Caching a slow third-party metadata API](arch-30-caching-a-slow-third-party-metadata-api.md) | Scaling | Easy |
| arch-31 | [1 GB CSV import pipeline](arch-31-1-gb-csv-import-pipeline.md) | Data | Medium |
| arch-32 | [Keeping a search index in sync with Postgres](arch-32-keeping-a-search-index-in-sync-with-postgres.md) | Data | Medium |
| arch-33 | [Earnings reporting without hurting the OLTP database](arch-33-earnings-reporting-without-hurting-the-oltp-database.md) | Data | Hard |
| arch-34 | [Background job system: Postgres-as-queue vs SQS](arch-34-background-job-system-postgres-as-queue-vs-sqs.md) | Reliability | Medium |
| arch-35 | [Run a scheduled job exactly once across N instances](arch-35-run-a-scheduled-job-exactly-once-across-n-instances.md) | Reliability | Easy |
| arch-36 | [Authentication for web and mobile](arch-36-authentication-for-web-and-mobile.md) | Security | Medium |
| arch-37 | [Public API for third-party developers](arch-37-public-api-for-third-party-developers.md) | API Design | Medium |
| arch-38 | [Rotating secrets without downtime](arch-38-rotating-secrets-without-downtime.md) | Security | Easy |
| arch-39 | [Disaster recovery for the primary database](arch-39-disaster-recovery-for-the-primary-database.md) | Reliability | Hard |
| arch-40 | [Extracting billing from a monolith](arch-40-extracting-billing-from-a-monolith.md) | Migration | Hard |
| arch-41 | [Black Friday: a 10x traffic spike](arch-41-black-friday-a-10x-traffic-spike.md) | Scaling | Hard |
| arch-42 | [Feature flags and safe gradual rollouts](arch-42-feature-flags-and-safe-gradual-rollouts.md) | Reliability | Medium |
| arch-43 | [Immutable audit log](arch-43-immutable-audit-log.md) | Security | Medium |
| arch-44 | [GDPR erasure across services while keeping legal records](arch-44-gdpr-erasure-across-services-while-keeping-legal-records.md) | Data | Hard |
| arch-45 | [Secure file uploads for patient documents](arch-45-secure-file-uploads-for-patient-documents.md) | Security | Easy |
| arch-46 | [Live order tracking in the browser at scale](arch-46-live-order-tracking-in-the-browser-at-scale.md) | Realtime | Easy |
| arch-47 | [Debugging: p99 latency doubled after a deploy](arch-47-debugging-p99-latency-doubled-after-a-deploy.md) | Debugging | Easy |
| arch-48 | [Debugging: customers report duplicate orders and charges](arch-48-debugging-customers-report-duplicate-orders-and-charges.md) | Debugging | Medium |
| arch-49 | [Debugging: Node service memory grows until OOM-killed](arch-49-debugging-node-service-memory-grows-until-oom-killed.md) | Debugging | Medium |
| arch-50 | [Debugging: database CPU at 100% and the connection pool exhausted](arch-50-debugging-database-cpu-at-100-and-the-connection-pool-exhaus.md) | Debugging | Medium |
| arch-51 | [E-commerce read paths: one source of truth, five read models](arch-51-e-commerce-read-paths-one-source-of-truth-five-read-models.md) | Data | Medium |
