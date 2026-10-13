---
id: provider-chain
title: Provider chain
kind: term
status: draft
aliases: [chain, whole chain]
defined_for: S28-notifications
rules_hash: 40dbca5e7c6a
---
# Provider chain
## Definition
A provider chain is the ordered list of outside providers that one channel (e-mail, SMS or push) can send through. The worker tries the first provider. If that provider has a [transient failure](transient-failure.md) or does not answer within the [provider timeout](provider-timeout.md), the worker moves to the next provider in the same attempt. A [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) skips any provider whose breaker is open until that provider's [probe](circuit-breaker-probe.md). If the provider reports a [permanent error](permanent-error.md), the worker stops right there and does not move along the chain.

## Example
The e-mail chain might be `[providerA, providerB]` (illustrative names). A send through `notify-email` times out after 10 seconds at `providerA`, so the same attempt sends it through `providerB`. Outside production, a stand-in reports `provider: "log"` and never reports `delivered`.

## Known gaps
- The spec does not say which real providers are in each chain or in what order. The webhook routes for `ses` and `twilio` suggest which providers are used, but they do not set the order.
- The spec does not say whether the marketing lines (`notify-marketing-*`) use the same chain as the transactional lines.
- The spec does not say when the circuit breaker opens or how often it probes.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-32
- [circuit-breaker-probe](circuit-breaker-probe.md)
- [delivery-line](delivery-line.md)
- [delivery-status](delivery-status.md)
- [email-line](email-line.md)
- [exhausted](exhausted.md)
- [failover-timeline-entry](failover-timeline-entry.md)
- [fallback-provider](fallback-provider.md)
- [mail-provider](mail-provider.md)
- [notification-channel](notification-channel.md)
- [notification-delivery](notification-delivery.md)
- [notify-email-queue](notify-email-queue.md)
- [notify-marketing-email-queue](notify-marketing-email-queue.md)
- [notify-push](notify-push.md)
- [permanent-error](permanent-error.md)
- [provider-failure](provider-failure.md)
- [provider-timeout](provider-timeout.md)
- [push-notification](push-notification.md)
- [send-budget](send-budget.md)
- [transient-error](transient-error.md)
- [transient-failure](transient-failure.md)
<!-- used-by:end -->
