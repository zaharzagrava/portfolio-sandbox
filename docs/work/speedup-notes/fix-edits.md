# Fix-edits notes: failures that might come from the speed-up edits

I ran every file of my list alone on shard 4 (one file at a time, nothing else running), and compared with a copy of the code from before the edits (commit 839860cf) where a failure looked odd.

## Changed (2 loops back to one-by-one)
- launch-events-holds, test "five parallel single-seat holds ... (20 runs)": the 20 rounds share one event. Letting a person in lets in the whole waiting line of that event, so rounds side by side took each other's place and failed with "not admitted". Back to one round at a time, same checks. The now unused helper was removed, so the file is the original plus a comment.
- launch-events-confirm, tests "ten confirms at once ... (20 runs)" and "when the ledger fails and two holds own one seat ... (20 runs)": same cause, same fix (back to one by one). The third loop in that file (sold out exactly once) uses a separate event per round, so it stays side by side and passes.

## Failures that the edits did NOT cause
- discussions-votes "100 distinct voters", discussions "100 concurrent voters", discussions-comments "50 users at one frozen instant": the same 503 appears on the pre-edit code. These tests were not edited. The Scylla conditional writes time out when 50 to 100 hit one partition at once. Not fixed here.
- public-api-limits "10 parallel identical creates" and public-api-resources "two parallel PATCH": both fail the same way on the pre-edit code (the first one is not edited at all). Left alone.
- Everything else in my list passed when the file ran alone: flash-sale-checkout, experiments-admin, flags-client, ads-campaigns, public-api-sandbox, media-upload, video-upload, video-delivery, notifications-observability, share-links-platform, sync-access, pickup-clusters, shop-functions-ops, shop-sso, tenancy-errors, oidc-login, password-reset, failure-counting, rate-limit-subjects. So their failures in the full run ("expected 429 got 200", "503", timeouts) come from running many files at once, not from the edits. Strong suspects: a "limiter store is down" test (media-upload and others) that breaks the shared Redis for the files running beside it, and Kafka topic creation errors.
- Slow files: share-links-clicks took 15 s and live-history 7 s alone (450 s and 126 s in the run). Those were waits that ran into their limit while the shared Kafka was failing, not slow code. Nothing to fix in the files.

## How to run one file on a shard
`shard-run.sh 4 1 <file>` refuses (shard 4 is outside 1..1) and `shard-run.sh 4 5 <file>` refuses too (only one file for 5 slices). I used the same environment from shard-env.sh and called vitest directly without --shard.
