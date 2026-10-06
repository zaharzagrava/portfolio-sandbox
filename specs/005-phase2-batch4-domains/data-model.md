# Data Model: Batch 4

No schema change and no registry entry change. None of the five domains has a Sequelize model, so the
registry placement check covers nothing new here. Their Postgres tables are raw SQL:

| Domain | Owned Postgres tables | Other stores |
|---|---|---|
| community | none (D5) | ScyllaDB (posts, comments, votes, follows, timelines), Redis (rankings, timelines, vote counters) |
| content | `Story`, `StoryDraft`, `StoryVersion` | Redis read model |
| notifications | `NotificationPreference`, `NotificationSettings`, `NotificationSuppression`, `PushDevice` | ScyllaDB inbox and delivery log, Redis unread and dedupe |
| discovery | none (read models only) | Elasticsearch, Redis, ClickHouse, S3 (trie snapshots) |
| seller-insights | `LeaderboardSnapshot`, `CompetitorWatch`, `CrawlTarget` | Redis boards and frontier, ClickHouse price history |

**Known violation (D-12):** discovery and community read catalog's `Product` table directly. The fix is
per capability (S26, S32–S35).
