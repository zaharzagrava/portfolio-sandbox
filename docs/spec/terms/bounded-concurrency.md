---
id: bounded-concurrency
title: BoundedConcurrency
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# BoundedConcurrency
## Definition
`BoundedConcurrency` is the [S01](../capabilities/S01-auth-sessions.md) domain class behind the rule that limits hash operations. Only a set number of password hash operations run at once, set by the [concurrency limit](concurrency-limit.md). Up to the [hash queue limit](hash-queue-limit.md), further requests wait. Requests beyond that are rejected immediately with `503` and a [`Retry-After` header ↗](../sw-external-terms.md#retry-after), which is a form of [load shedding](load-shedding.md). Design intent (not stated in the spec): hashing is deliberately expensive, so a burst of logins or registrations could otherwise use up CPU and memory for every other request.

## Example
A burst of logins fills every running slot and the whole queue. The next request is rejected without computing a hash:
```
HTTP/1.1 503 Service Unavailable
Retry-After: 1
```

## Known gaps
- The spec does not say the actual concurrency limit or queue limit, or where they are configured.
- The spec does not say whether the limit applies per process or to the whole fleet.
- The spec does not say whether `BoundedConcurrency` is used for anything besides hashing, or which error code goes in the `503` body.

## Used by
<!-- used-by:start -->
- [concurrency-limit](concurrency-limit.md)
- [hash-queue-limit](hash-queue-limit.md)
- [load-shedding](load-shedding.md)
<!-- used-by:end -->
