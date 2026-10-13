---
id: failover-timeline-entry
title: failover timeline entry
kind: term
status: draft
aliases: [failover]
defined_for: S28-notifications
rules_hash: e8e7dfb2a8c2
---
# failover timeline entry
## Definition
A failover timeline entry is a record on a [delivery's timeline](delivery-timeline.md). It shows that one [provider](mail-provider.md) failed and [the same attempt](job-attempt.md) moved on to the next provider in the channel's [chain](provider-chain.md). Failover happens on a [transient provider failure](transient-failure.md) or on the [provider timeout](provider-timeout.md). It does not happen on a [permanent failure](permanent-error.md). Because the send stays inside the same attempt, failover does not use up a retry from the line's [attempt budget](consumer-attempt-budget.md).

## Example
The primary e-mail provider returns a transient error for a password-reset mail. The worker sends through the next provider in the e-mail chain within the same attempt. The delivery's timeline gets a `failover` entry before its `sent` entry.

## Known gaps
- The spec does not say whether `failover` is a status. It is missing from the [timeline status list](delivery-status.md) in S28.R-12, so it may be a separate kind of entry.
- The spec does not say what the entry holds, for example which provider failed, the reason, or which provider was used next.
- The spec does not say whether a timeline entry is written when the [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) skips an open provider.

## Used by
<!-- used-by:start -->
- [consumer-attempt-budget](consumer-attempt-budget.md)
- [delivery-status](delivery-status.md)
- [delivery-timeline](delivery-timeline.md)
- [job-attempt](job-attempt.md)
- [mail-provider](mail-provider.md)
- [permanent-error](permanent-error.md)
- [provider-chain](provider-chain.md)
- [provider-timeout](provider-timeout.md)
- [transient-error](transient-error.md)
- [transient-failure](transient-failure.md)
<!-- used-by:end -->
