---
id: invalid-topics
title: invalid_topics (400)
kind: term
status: draft
aliases: [invalid_topics]
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# invalid_topics (400)
## Definition
`invalid_topics` is the [problem+json ↗](../sw-external-terms.md#problem-json) error code in a `400` answer from the [stream endpoint](stream-connection.md) when the `topics` list is malformed. [The hub](realtime-hub.md) refuses the request before [admission](connection-admission.md) and creates no [subscription](realtime-subscription.md). In the code, this refusal is `StreamInvalidTopicsError`.

## Example
```
GET /api/streams?topics=,,     (illustrative malformed list)
→ 400, problem+json, code: invalid_topics
```

## Known gaps
- The spec does not say whether a request with zero topics, or with more than the topic limit, gets `invalid_topics` or a different code.
- The spec does not give the topic grammar. The scenarios on grammar are listed without any stated rule, so "malformed" is not defined precisely.

## Used by
<!-- used-by:start -->
- [connection-admission](connection-admission.md)
- [realtime-hub](realtime-hub.md)
- [realtime-subscription](realtime-subscription.md)
- [stream-connection](stream-connection.md)
<!-- used-by:end -->
