---
id: exhausted
title: exhausted
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# exhausted
## Definition
`exhausted` is the reason recorded on a delivery that ended as `failed` because it used up all its retries. This happens only after [transient failures](transient-failure.md) of the whole [provider chain](provider-chain.md). Each try first [fails over](fallback-provider.md) through the chain within the same attempt. When no provider succeeds, the delivery goes back to its line with [exponential backoff ↗](../sw-external-terms.md#exponential-backoff) and [jitter](jitter.md). When the attempt limit is reached, the delivery is [dead-lettered](dead-letter-topic.md) as `failed` with reason `exhausted`. [A permanent failure](permanent-error.md) never reaches this point: it is marked `failed` at once, with no retry. A send held back for being over the [send budget](send-budget.md) does not use up an attempt.

## Example
A push delivery where every push provider times out on every attempt (delays are upper bounds, because of full jitter):
```
attempt 1 fails → wait up to 30 s → attempt 2 fails → wait up to 60 s
→ attempt 3 → up to 120 s → attempt 4 → up to 240 s → attempt 5 fails
→ dead-lettered, status failed, reason exhausted
```

## Known gaps
- The spec does not say whether the first send counts as one of the attempts in "at most 5 attempts".
- The spec does not say whether `exhausted` is stored in the [delivery timeline](delivery-timeline.md), in the dead-letter record, or in both.
- The spec does not say whether an `exhausted` delivery can be [redriven](dead-letter-redrive.md), or what happens to it after that.

## Used by
<!-- used-by:start -->
- [dead-letter-redrive](dead-letter-redrive.md)
- [dead-letter-topic](dead-letter-topic.md)
- [delivery-timeline](delivery-timeline.md)
- [fallback-provider](fallback-provider.md)
- [jitter](jitter.md)
- [permanent-error](permanent-error.md)
- [provider-chain](provider-chain.md)
- [send-budget](send-budget.md)
- [transient-failure](transient-failure.md)
<!-- used-by:end -->
