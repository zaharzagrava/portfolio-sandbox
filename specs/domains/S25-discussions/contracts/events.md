# Contract: events produced by S25 (topic `discussion.events`, key = `postId`)

Envelope: S53 (`eventId`, `type`, `version`, `occurredAt`, `aggregateType = "discussion"`, `aggregateId = postId`). Defined with `defineEvent` in `packages/contracts/src/community/events.ts` and registered by `DiscussionsModule`; the topic registry must map aggregate type `discussion` to `discussion.events` (verified by the first relay task before the relay is written; the S53 type pattern allows `discussion.post_created`). Events are recorded in the creation/deletion batch (data-model: `recorded_events`, `pending_events`) and relayed at least once with a stable `eventId`. No event for votes, shadow-ban changes or shadow content.

| Type (v1) | Payload | Consumers |
|---|---|---|
| `discussion.post_created` | `{postId, boardId, authorId, title, createdAt}` | S26 (feed item), S39 |
| `discussion.post_deleted` | `{postId, boardId, deletedBy: "author" or "moderator"}` | S26 (remove feed items) |
| `discussion.comment_created` | `{commentId, postId, boardId, authorId, parentCommentId or null, parentAuthorId or null, postAuthorId, preview, createdAt}`; `preview` = first 140 code points of the plain text | S28 (reply and comment notifications) |
| `discussion.comment_deleted` | `{commentId, postId, boardId, deletedBy}` | none required |
| `discussion.vote_anomaly_detected` | `{targetId, targetType, boardId, zeroWeightVotes, windowSeconds}` | none (observability) |

Confirmation for S28 (`packages/contracts/src/notifications/consumed-events.ts`): `discussion.comment_created` consumes `postId, authorId, parentAuthorId?, postAuthorId, preview`; all are present with the same names. S28 may switch its import to the schemas exported here.

## Export (R1)

`DiscussionQueryService.getPostsByIds(ids: string[]): Promise<Map<string, PostSummaryDto>>` from `@app/domains/community`: at most 100 IDs (more is a `RangeError`), one `IN` query, deleted and shadow posts absent, `PostSummaryDto = {postId, boardId, authorId, title, createdAt, score, commentCount}`. Consumer: S26.
