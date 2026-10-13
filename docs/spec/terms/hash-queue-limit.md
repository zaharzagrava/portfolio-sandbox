---
id: hash-queue-limit
title: Hash queue limit
kind: term
status: draft
aliases: [queue limit]
defined_for: S01-auth-sessions
rules_hash: 771c3b3eddd5
---
# Hash queue limit
## Definition
Password hashing and verification in [S01](../capabilities/S01-auth-sessions.md) allow only a fixed number of hash operations to run at the same time. The hash queue limit caps how many more requests may wait for a free slot. When the queue is full, the service rejects the request at once with `503` and a [`Retry-After` header ↗](../sw-external-terms.md#retry-after). Design intent (not stated in the spec): [Argon2id ↗](../sw-external-terms.md#argon2id) hashing is costly by design, so the limit keeps a flood of logins or registrations from using up CPU and memory.

## Example
All hash slots are busy and the queue is full when another login arrives:
```
HTTP/1.1 503
Retry-After: 1
```
The client should retry after one second.

## Known gaps
- The spec does not say the values of the [concurrency limit](concurrency-limit.md) or the queue limit, or whether they can be configured.
- The spec does not say whether the limits apply per process or [across the whole fleet](fleet-wide-limit.md). Per process is likely for an in-memory gate, but the code does not confirm it.
- The spec does not say which error code the `503` body carries.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-12
- [bounded-concurrency](bounded-concurrency.md)
- [concurrency-limit](concurrency-limit.md)
- [fleet-wide-limit](fleet-wide-limit.md)
- [password-hash](password-hash.md)
<!-- used-by:end -->
