# Fixes for the "expected 429 got 200" group (shard 10 only)

Most of the listed files passed once the earlier fixes were in. I ran them together in one process (identity, tenancy, media, flags, notifications, catalog-sync, discovery, marketing, fulfilment, orders, catalog, realtime) and the four developer-platform public-api files together. All passed except the three below, which had their own causes.

- catalog-sync/sync-fields: the test makes 20 products in one shop in a loop, but the free plan allows 10. Same cause as the public-api files. Fix: this spec now gives the shop an "unlimited plan" answer (the plan limit itself is proved in the catalog plan-limit spec).
- realtime/realtime-publisher (late-store test): it counted Redis commands through the server-wide counters, which other shards running at the same time also change. Fix: it now watches the command stream and keeps only commands in its own Redis database. The check (exactly one script call, no retry) is the same.
- orders/flash-sale-public: same idea, in the shared flash test helper: the command recorder saw other shards' commands (975 reads instead of 0). It now keeps only its own Redis database.
- projections/replay-rebuild (side-effects test): it swaps the global log writer to read one log line; other tests of the file had been made to run at the same time and reset it. This test is back to running on its own, nothing else changed.

Not reproduced (passed when run together on shard 10): public-api, public-api-sandbox, password-reset, auth-register, shop-sso, media-upload, video-delivery, flags-client, notifications-routing, sync-access, autocomplete-suggest, ads-platform, courier-locations, collab-ops, consumer-idempotency. Their earlier failures came from the old run before the plan-cap and other fixes.
