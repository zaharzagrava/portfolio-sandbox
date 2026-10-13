---
id: invalid-query
title: invalid_query (400)
kind: term
status: draft
aliases: [invalid_query]
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# invalid_query (400)
## Definition
`invalid_query` is the [problem+json ↗](../sw-external-terms.md#problem-json) error code in a `400` answer from [the stream endpoint](stream-connection.md) when the request has a query parameter other than `topics`. Like [`invalid_topics`](invalid-topics.md), it stops the request before [admission](connection-admission.md) and creates no [subscription](realtime-subscription.md). This is the stream endpoint's version of unknown query parameter rejection.

## Example
```
GET /api/streams?topics=user:<A>&debug=1     (debug is illustrative)
→ 400, problem+json, code: invalid_query
```

## Known gaps
- The spec does not say which code a request with no `topics` parameter at all receives: `invalid_query` or `invalid_topics`.

## Used by
<!-- used-by:start -->
- [connection-admission](connection-admission.md)
- [realtime-subscription](realtime-subscription.md)
- [stream-connection](stream-connection.md)
<!-- used-by:end -->
