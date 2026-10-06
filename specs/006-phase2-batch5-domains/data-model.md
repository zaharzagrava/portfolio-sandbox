# Data Model: Batch 5

No schema change, and no registry entry change. None of the four domains has a Sequelize model.

| Domain | Owned Postgres tables (raw SQL) | Other stores |
|---|---|---|
| developer-platform | `ApiKey`, `ShopApiSettings`, `WebhookEndpoint`, `WidgetSite` | Redis key cache, DynamoDB webhook attempts, ClickHouse request logs |
| marketing | `AdCampaign`, `AdBillingRun` | DynamoDB links, Redis ID leases, ClickHouse click aggregates |
| experimentation | `FeatureFlag`, `FlagAudit`, `Experiment` | ClickHouse events, Redis pub/sub ruleset updates |
| assistant | `KnowledgeDocument`, `KnowledgeChunk` (pgvector) | ScyllaDB conversations, Redis generation buffer |

**Registry coverage is complete.** All 100 tables are owned by the 25 domains or the 4 infrastructure
owners. The 30 models live with their owners. The cross-domain accesses that remain are listed by
`pnpm check:table-ownership` (debt D-7 and D-12).
