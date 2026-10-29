# Fintech pack (bonus)

20 payments / rental-fintech tasks kept from the first version of the architecture set (ACH debits, payouts, autopay, KYC, fraud, disputes, PCI, money representation, provider migration…). Use them for fintech interviews; the universal set is [../system-design/](../system-design/README.md).

| # | Task | Topic | Level |
|---|---|---|---|
| fin-01 | [ACH rent debits with late returns: payment state machine](fin-01-ach-rent-debits-with-late-returns-payment-state-machine.md) | Fintech pack · Payments | Hard |
| fin-02 | [Card payments with Stripe: intents, 3DS/SCA, webhooks](fin-02-card-payments-with-stripe-intents-3ds-sca-webhooks.md) | Fintech pack · Payments | Medium |
| fin-03 | [Landlord payouts: splits, fees, batching, holds](fin-03-landlord-payouts-splits-fees-batching-holds.md) | Fintech pack · Payments | Hard |
| fin-04 | [Daily reconciliation: provider and bank vs ledger](fin-04-daily-reconciliation-provider-and-bank-vs-ledger.md) | Fintech pack · Data | Medium |
| fin-05 | [Recurring autopay scheduler](fin-05-recurring-autopay-scheduler.md) | Fintech pack · Payments | Medium |
| fin-06 | [Late fees and dunning per landlord](fin-06-late-fees-and-dunning-per-landlord.md) | Fintech pack · Payments | Easy |
| fin-07 | [Multi-provider payment routing and failover](fin-07-multi-provider-payment-routing-and-failover.md) | Fintech pack · Payments | Hard |
| fin-08 | [Storing PMS credentials: KMS, rotation, revocation](fin-08-storing-pms-credentials-kms-rotation-revocation.md) | Fintech pack · Security | Easy |
| fin-09 | [Bulk initial import when onboarding a PMS partner](fin-09-bulk-initial-import-when-onboarding-a-pms-partner.md) | Fintech pack · Scaling | Medium |
| fin-10 | [KYC with an async vendor and manual review](fin-10-kyc-with-an-async-vendor-and-manual-review.md) | Fintech pack · Compliance | Easy |
| fin-11 | [Pre-payment fraud and risk checks](fin-11-pre-payment-fraud-and-risk-checks.md) | Fintech pack · Security | Medium |
| fin-12 | [Refunds, chargebacks and disputes](fin-12-refunds-chargebacks-and-disputes.md) | Fintech pack · Payments | Hard |
| fin-13 | [Money representation: amounts, rounding, currencies, FX](fin-13-money-representation-amounts-rounding-currencies-fx.md) | Fintech pack · Payments | Easy |
| fin-14 | [PCI DSS scope reduction: tokenization and hosted fields](fin-14-pci-dss-scope-reduction-tokenization-and-hosted-fields.md) | Fintech pack · Security | Medium |
| fin-15 | [Generating 1M monthly receipt and statement PDFs](fin-15-generating-1m-monthly-receipt-and-statement-pdfs.md) | Fintech pack · Scaling | Medium |
| fin-16 | [Back-office RBAC and maker-checker approvals](fin-16-back-office-rbac-and-maker-checker-approvals.md) | Fintech pack · Security | Medium |
| fin-17 | [Migrating from payment provider A to B with zero downtime](fin-17-migrating-from-payment-provider-a-to-b-with-zero-downtime.md) | Fintech pack · Payments | Hard |
| fin-18 | [Shared rate limit for a third-party API across many workers](fin-18-shared-rate-limit-for-a-third-party-api-across-many-workers.md) | Fintech pack · Integrations | Medium |
| fin-19 | [Trace one payment across services](fin-19-trace-one-payment-across-services.md) | Fintech pack · Observability | Easy |
| fin-20 | [Postgres and a secondary store in sync](fin-20-postgres-and-a-secondary-store-in-sync.md) | Fintech pack · Data | Hard |
