# Events, realtime topics, jobs and rate limits (S23)

## Event stream (key `streamId`; envelope `{eventId, type, version, occurredAt, aggregateId}`; plain producer)

| Type | v | Payload | Producer | Consumers |
|---|---|---|---|---|
| `live.comment_posted` | 1 | `{streamId, commentId, authorId, authorName, text, at, priority?}` | comment service, before the comment is visible | history writer (`live-comments-history`), async moderation (`live-moderation`) |
| `live.comment_removed` | **2** | `{streamId, commentId, at, reason: 'moderator'|'auto', actorId?, score?}` | removal service, once per comment per 24 h | history writer |
| `live.reactions_aggregated` | 1 | `{streamId, second, reactions}` | ticker, once per non-empty (stream, second) | none yet (S40 may read) |

v1 of `live.comment_removed` (free-text reason) is removed; no consumer outside this domain exists. Consumers reject any other version without a write (AS-45).

## Outbox (topic `launch_events.events`, key `streamId`, same transaction as the status change)

| Type | v | Payload |
|---|---|---|
| `live.stream_started` | 1 | `{streamId, shopId, title, launchEventId, startedAt}` |
| `live.stream_ended` | 1 | `{streamId, shopId, endedAt, durationSeconds}` |

The spec text writes `launch-events.events`; S22 settled `launch_events.events` (aggregate types cannot contain `-`). Consumers (S28, J03) subscribe to the underscore name.

## Realtime (S51)

- Registered by `LiveTopicsModule`: `stream:<id>` public (`policy: () => true`), events `status {status}`, `pin pinSchema|null`, `comment_removed {id}`, `stats {second, reactions, viewers}`. `stats` is published with `replay: false`; the others replay.
- Internal: `livefeed:<id>` (declared in `RealtimeTopicPrefixes`, **no route**): a subscribe from any client is refused like an unknown topic. Consumed only through `TopicSubscriber` by the batcher.
- SSE events on `GET /api/live/:streamId/events`: `snapshot {status, pin, recent}` first; then `comments {items (LiveComment & {mine?: true})[], rate}` at most once per 250 ms window, `pin`, `comment_removed`, `status`, `stats`; `: ping` every 15 s; `retry: 3000`.

## Jobs (S49)

`launch-events.live-reconcile`: payload `{}` (strict zod contract in `application/live.job-types.ts`), recurring every 30 s, `overlap: skip`, concurrency 1.

## Rate limits (S50, declared in `rate-limit-policies.ts`)

| Policy | Limit | Key | Fail mode |
|---|---|---|---|
| `live.comment` | 3 / 10 s | user | open |
| `live.reaction` | 5 / 1 s | user | open |
| `live.snapshot.ip` | 120 / 60 s | ip | open |
| `live.events.ip` | 30 / 60 s | ip | open |

## Metrics (AS-52)

`live_comments_total{result,reason}`, `live_batch_items`, `live_window_comments`, `live_delivery_lag_seconds`, `live_viewers`, `live_viewers_dropped_total{reason}`, `live_reactions_total`, `live_stats_published_total`, `live_removals_total{source}`, `live_history_lag_seconds`, `live_consumer_failures_total{consumer}`, `live_moderation_failed_total`, `live_limiter_unavailable_total`. No label carries text, e-mail, token or `clientId`.
