# Architecture practice tasks

50 open design questions for a backend-leaning Full Stack Node role in rental-payments fintech (PMS integrations, open banking, payment providers; Node/TS, Postgres, AWS). One file per task: the question, then the model answer folded.

The already-rehearsed webhook-ingestion design is [practice/01-pms-webhook-ingestion.md](../01-pms-webhook-ingestion.md).

| # | Task | Topic | Level |
|---|---|---|---|
| arch-01 | [Open banking account linking and transaction sync](arch-01-open-banking-account-linking-and-transaction-sync.md) | Integrations | Medium |
| arch-02 | [ACH rent debits with late returns: payment state machine](arch-02-ach-rent-debits-with-late-returns-payment-state-machine.md) | Payments | Hard |
| arch-03 | [Card payments with Stripe: intents, 3DS/SCA, webhooks](arch-03-card-payments-with-stripe-intents-3ds-sca-webhooks.md) | Payments | Medium |
| arch-04 | [Landlord payouts: splits, fees, batching, holds](arch-04-landlord-payouts-splits-fees-batching-holds.md) | Payments | Hard |
| arch-05 | [Double-entry ledger for tenant and landlord balances](arch-05-double-entry-ledger-for-tenant-and-landlord-balances.md) | Data | Medium |
| arch-06 | [Daily reconciliation: provider and bank vs ledger](arch-06-daily-reconciliation-provider-and-bank-vs-ledger.md) | Data | Medium |
| arch-07 | [Polling-based PMS integration without webhooks](arch-07-polling-based-pms-integration-without-webhooks.md) | Integrations | Medium |
| arch-08 | [Outbound webhooks to partners](arch-08-outbound-webhooks-to-partners.md) | Integrations | Medium |
| arch-09 | [Idempotent payment-creation API](arch-09-idempotent-payment-creation-api.md) | Payments | Easy |
| arch-10 | [Recurring autopay scheduler](arch-10-recurring-autopay-scheduler.md) | Payments | Medium |
| arch-11 | [Late fees and dunning per landlord](arch-11-late-fees-and-dunning-per-landlord.md) | Payments | Easy |
| arch-12 | [Multi-provider payment routing and failover](arch-12-multi-provider-payment-routing-and-failover.md) | Payments | Hard |
| arch-13 | [Storing PMS credentials: KMS, rotation, revocation](arch-13-storing-pms-credentials-kms-rotation-revocation.md) | Security | Easy |
| arch-14 | [Bulk initial import when onboarding a PMS partner](arch-14-bulk-initial-import-when-onboarding-a-pms-partner.md) | Scaling | Medium |
| arch-15 | [KYC with an async vendor and manual review](arch-15-kyc-with-an-async-vendor-and-manual-review.md) | Compliance | Easy |
| arch-16 | [Pre-payment fraud and risk checks](arch-16-pre-payment-fraud-and-risk-checks.md) | Security | Medium |
| arch-17 | [Refunds, chargebacks and disputes](arch-17-refunds-chargebacks-and-disputes.md) | Payments | Hard |
| arch-18 | [Money representation: amounts, rounding, currencies, FX](arch-18-money-representation-amounts-rounding-currencies-fx.md) | Payments | Easy |
| arch-19 | [Immutable audit log for compliance](arch-19-immutable-audit-log-for-compliance.md) | Security | Medium |
| arch-20 | [PCI DSS scope reduction: tokenization and hosted fields](arch-20-pci-dss-scope-reduction-tokenization-and-hosted-fields.md) | Security | Medium |
| arch-21 | [Generating 1M monthly receipt and statement PDFs](arch-21-generating-1m-monthly-receipt-and-statement-pdfs.md) | Scaling | Medium |
| arch-22 | [Real-time payment status in the tenant web app](arch-22-real-time-payment-status-in-the-tenant-web-app.md) | Integrations | Easy |
| arch-23 | [Back-office RBAC and maker-checker approvals](arch-23-back-office-rbac-and-maker-checker-approvals.md) | Security | Medium |
| arch-24 | [GDPR erasure across services while keeping financial records](arch-24-gdpr-erasure-across-services-while-keeping-financial-records.md) | Data | Hard |
| arch-25 | [Migrating from payment provider A to B with zero downtime](arch-25-migrating-from-payment-provider-a-to-b-with-zero-downtime.md) | Payments | Hard |
| arch-26 | [Shared rate limit for a third-party API across many workers](arch-26-shared-rate-limit-for-a-third-party-api-across-many-workers.md) | Integrations | Medium |
| arch-27 | [Background job system: Postgres-as-queue vs SQS](arch-27-background-job-system-postgres-as-queue-vs-sqs.md) | Reliability | Medium |
| arch-28 | [Distributed cron: run a job once across N instances](arch-28-distributed-cron-run-a-job-once-across-n-instances.md) | Reliability | Easy |
| arch-29 | [Zero-downtime schema change on a 200M-row Postgres table](arch-29-zero-downtime-schema-change-on-a-200m-row-postgres-table.md) | Data | Hard |
| arch-30 | [Multi-tenant data isolation in Postgres](arch-30-multi-tenant-data-isolation-in-postgres.md) | Security | Medium |
| arch-31 | [Caching a slow partner API](arch-31-caching-a-slow-partner-api.md) | Scaling | Easy |
| arch-32 | [1 GB CSV upload and import pipeline](arch-32-1-gb-csv-upload-and-import-pipeline.md) | Data | Medium |
| arch-33 | [Search with filters: Postgres indexes vs OpenSearch](arch-33-search-with-filters-postgres-indexes-vs-opensearch.md) | Data | Medium |
| arch-34 | [Monthly revenue reporting without hurting the OLTP database](arch-34-monthly-revenue-reporting-without-hurting-the-oltp-database.md) | Data | Hard |
| arch-35 | [Notification service: email, SMS, push](arch-35-notification-service-email-sms-push.md) | Messaging | Medium |
| arch-36 | [Public partner API: auth, scopes, limits, versions](arch-36-public-partner-api-auth-scopes-limits-versions.md) | API Design | Medium |
| arch-37 | [Authentication for web and mobile](arch-37-authentication-for-web-and-mobile.md) | Security | Medium |
| arch-38 | [Trace one payment across services](arch-38-trace-one-payment-across-services.md) | Observability | Easy |
| arch-39 | [Rent-day traffic spike on the 1st](arch-39-rent-day-traffic-spike-on-the-1st.md) | Scaling | Hard |
| arch-40 | [Extract payments from the monolith](arch-40-extract-payments-from-the-monolith.md) | Migration | Hard |
| arch-41 | [Move-in saga with compensations](arch-41-move-in-saga-with-compensations.md) | Distributed Systems | Medium |
| arch-42 | [Transactional outbox and idempotent consumers](arch-42-transactional-outbox-and-idempotent-consumers.md) | Distributed Systems | Medium |
| arch-43 | [Disaster recovery for the payments database](arch-43-disaster-recovery-for-the-payments-database.md) | Reliability | Hard |
| arch-44 | [Rotating secrets without downtime](arch-44-rotating-secrets-without-downtime.md) | Security | Easy |
| arch-45 | [Secure storage for lease documents](arch-45-secure-storage-for-lease-documents.md) | Security | Easy |
| arch-46 | [Sandbox and test mode for partners](arch-46-sandbox-and-test-mode-for-partners.md) | Integrations | Medium |
| arch-47 | [p99 latency doubled after a deploy](arch-47-p99-latency-doubled-after-a-deploy.md) | Debugging | Easy |
| arch-48 | [Tenants report duplicate charges](arch-48-tenants-report-duplicate-charges.md) | Debugging | Medium |
| arch-49 | [Postgres and a secondary store in sync](arch-49-postgres-and-a-secondary-store-in-sync.md) | Data | Hard |
| arch-50 | [Tenant checkout API](arch-50-tenant-checkout-api.md) | API Design | Medium |
