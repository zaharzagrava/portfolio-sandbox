---
id: cache-store-circuit-breaker
title: Cache store circuit breaker
kind: term
status: draft
aliases: [store skipped]
defined_for: S52-cache-toolkit
rules_hash: 0b8def0ab431
---
# Cache store circuit breaker
## Definition
The cache store circuit breaker stops the [toolkit](cache-toolkit.md) from calling the [shared store](l2-cache.md) after repeated failures. While the breaker is open, the store is skipped and reads are answered by the [single-flighted loader ↗](../sw-external-terms.md#single-flight). After a pause, one [circuit breaker probe](circuit-breaker-probe.md) call tries the store again. If the probe succeeds, the breaker closes; otherwise the store keeps being skipped. [The Decisions](decisions.md) give its purpose: to protect the database while the store is down.

## Example
The store fails 5 times in a row within 10 s. For the next 5 s, [`getOrLoad`](get-or-load.md) does not contact the store and serves reads from the loader. Then one probe call decides whether normal store reads resume.

## Known gaps
- The spec does not say whether the breaker is held by each process or shared across instances.
- The spec does not say whether the failure count, window and open period can be configured.
- The spec does not say whether store timeouts count as failures.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): B-17
- [cache-toolkit](cache-toolkit.md)
- [circuit-breaker-probe](circuit-breaker-probe.md)
- [decisions](decisions.md)
- [fallback-token-bucket](fallback-token-bucket.md)
- [l2-cache](l2-cache.md)
- [might-contain](might-contain.md)
- [store-timeout](store-timeout.md)
<!-- used-by:end -->
