---
id: fallback-provider
title: Fallback e-mail provider
kind: term
status: draft
aliases: [failover, primary e-mail provider]
defined_for: S28-notifications
rules_hash: c7994bf10161
---
# Fallback e-mail provider
## Definition
The fallback e-mail provider is the next provider after the primary in the e-mail channel's [ordered provider chain](provider-chain.md). When the primary fails with a [transient error](transient-error.md) or times out, the delivery is sent through the fallback in the same attempt, so no [retry attempt](job-attempt.md) is used. A [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) skips an open provider until its [probe](circuit-breaker-probe.md), which can send traffic straight to the fallback. Each provider has its own [send budget](send-budget.md) enforced by the rate limiter.

## Example
The primary e-mail provider fails transiently while sending a password-reset mail. The worker sends the same message through the fallback provider in the same attempt. The [delivery timeline](delivery-timeline.md) records [`failover`](failover-timeline-entry.md) and then `sent`.

## Known gaps
- The spec does not name the primary or fallback e-mail provider. A `POST /notifications/webhooks/ses` callback exists, but which position SES holds in the chain is not stated.
- The spec does not include `failover` in the timeline status list of S28.R-12, but the acceptance scenario says the timeline records it. It may be a timeline entry rather than a status; not confirmed in the code.
- The spec does not say whether a [permanent failure](permanent-error.md) at the fallback undoes or overrides the failover, beyond S28.R-33 (no failover, no retry on a permanent failure).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-09
- [circuit-breaker-probe](circuit-breaker-probe.md)
- [dead-push-token](dead-push-token.md)
- [delivery-timeline](delivery-timeline.md)
- [exhausted](exhausted.md)
- [job-attempt](job-attempt.md)
- [permanent-error](permanent-error.md)
- [provider-chain](provider-chain.md)
- [send-budget](send-budget.md)
- [transient-error](transient-error.md)
<!-- used-by:end -->
