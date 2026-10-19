---
id: chat-history
title: Chat history
kind: term
status: draft
aliases: [history]
defined_for: J03-launch-day
rules_hash: de29b6f0c773
---
# Chat history
## Definition
Chat history is the stored record of comments posted during a live stream. The [`live-comments-history` consumer group](consumer-group.md) fills it from [`live.events`](live-events-topic.md). A comment retried with the same `clientId` and the same text is stored once. A removed or moderated comment must not appear in history, whatever order its post and removal arrive in. Late joiners see the same comments through recent comments.

## Example
A viewer posts "Love the colour!" with `clientId` `c-123` (illustrative values). The client retries the post, and history still holds one comment. A moderator then removes it, and it disappears from both history and recent comments.

## Known gaps
- The spec does not say how long history keeps comments.
- The facts name no route for reading history.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
