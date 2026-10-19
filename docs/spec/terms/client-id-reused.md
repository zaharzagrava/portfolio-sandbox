---
id: client-id-reused
title: client_id_reused (422)
kind: term
status: draft
aliases: [client_id_reused]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# client_id_reused (422)
## Definition
`client_id_reused` is the [error code](error-code.md) returned when a [live-stream comment](live-stream.md) reuses a [`clientId`](comment-client-id.md) with different text from the comment already stored under that `clientId`. It is sent with status 422. No new comment is created. A retry with the same text is not an error; it simply returns the single existing comment.

## Example
```
POST (comment route not named in the facts)
{ "clientId": "c-123", "text": "Too pricey" }   // c-123 already used for "Love this colour!"
→ 422, code: client_id_reused
```
The `clientId` value and text are illustrative.

## Known gaps
- The spec does not give the comment route or the full [problem body](problem-body.md) for this error.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
