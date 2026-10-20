---
id: comment-moderation
title: Comment removal and moderation
kind: term
status: draft
aliases: [moderated comment, removed comment]
defined_for: J03-launch-day
rules_hash: 2328b3bbf69a
---
# Comment removal and moderation
## Definition
A [live-stream comment](live-stream.md) can be removed or moderated after it is posted. Viewers receive removals as events on the [live event stream](realtime-event.md). A removed or moderated comment must never appear in [recent comments](recent-comments.md) or in [history](recent-comments.md). This holds whatever order the post and the removal arrive in. Design intent (not stated in the spec): [consumers](event-consumer.md) such as `live-comments-history` may see a removal before its post, so they must not re-add the comment.

## Example
The brand removes a comment during a stream. Connected viewers receive the removal, and the comment is absent from recent comments and history. The result is the same even when the removal is processed before the post (J03.R-19, J03 AS-23 to AS-25).

## Known gaps
- The spec does not say who may remove or moderate a comment, or the route that does it.
- The spec does not say how "removed" differs from "moderated".

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-19
- [comment-client-id](comment-client-id.md)
- [event-consumer](event-consumer.md)
- [live-stream](live-stream.md)
- [realtime-event](realtime-event.md)
- [recent-comments](recent-comments.md)
<!-- used-by:end -->
