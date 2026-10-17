---
id: provider-failure
title: Provider failure
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e8e7dfb2a8c2
---
# Provider failure
## Definition
A provider failure happens when an e-mail, SMS or push provider does not accept a delivery. A [provider timeout](provider-timeout.md) also counts as one. Each failure is either a [transient failure](transient-failure.md) or a [permanent error](permanent-error.md), and the two are handled differently. On a transient failure, the delivery fails over to the next provider in the [provider chain](provider-chain.md) within the same attempt. If the whole chain fails, the [delivery line](notification-line.md) retries it later. On a permanent error, the system does not fail over or retry. Instead, it suppresses the address or removes the dead push token and marks the delivery `failed`.

## Example
- **Transient failure:** the first e-mail provider in the chain does not answer within 10 seconds. The same attempt sends through the next provider, and the timeline records `failover`. If every provider fails, the delivery goes back to `notify-email`. It is retried with backoff (base 30 s, doubling, capped at 900 s, full jitter) for at most 5 attempts. After that, it is dead-lettered as `failed` with reason `exhausted`.
- **Permanent error:** a provider reports that the address does not exist. That address is suppressed and the delivery is `failed`, with no retry.

## Known gaps
- The spec does not say which provider responses (status codes or error kinds) count as transient and which count as permanent.
- The spec does not say what opens a provider's circuit breaker or when its probe runs.
- Not confirmed in the code: where the transient/permanent classification is made for each provider.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-21
- [invalid-output](invalid-output.md)
- [notification-line](notification-line.md)
- [permanent-error](permanent-error.md)
- [provider-chain](provider-chain.md)
- [provider-timeout](provider-timeout.md)
- [transient-error](transient-error.md)
- [transient-failure](transient-failure.md)
<!-- used-by:end -->
