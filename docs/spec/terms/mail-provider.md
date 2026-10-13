---
id: mail-provider
title: Mail provider
kind: term
status: draft
aliases: [provider]
defined_for: S28-notifications
rules_hash: ef40049eb7e3
---
# Mail provider
## Definition
A provider is the external service that actually sends a message on a [channel](notification-channel.md). For e-mail that is the mail provider. Each channel has an [ordered chain of providers](provider-chain.md). A [transient failure](transient-failure.md) or a timeout moves the send to the next provider in the same [attempt](job-attempt.md), and a [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) skips a provider that is down until its [probe](circuit-breaker-probe.md). Each provider has a [send budget](send-budget.md) enforced by the rate limiter, and providers report outcomes back through [webhook callbacks](provider-callback.md).

## Example
A worker on [`notify-email`](notify-email-queue.md) hands a rendered message to the first e-mail provider in the chain. If that provider times out, the same attempt tries the next provider. Delivery outcomes come back later on `POST /notifications/webhooks/ses`.

## Known gaps
- The spec does not name the providers in each chain or their order. SES and Twilio are known only from the webhook paths.
- The spec does not say whether failover can cause a message to be sent twice when the first provider actually accepted it before timing out.
- Outside production a [stand-in](provider-stand-in.md) reports `provider: "log"`. The spec does not say how it connects to `GET /dev/mailbox`.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-13
- [circuit-breaker-probe](circuit-breaker-probe.md)
- [contact-data](contact-data.md)
- [delivery-timeline-expired](delivery-timeline-expired.md)
- [failover-timeline-entry](failover-timeline-entry.md)
- [in-memory-mailbox](in-memory-mailbox.md)
- [job-attempt](job-attempt.md)
- [notification-catalog](notification-catalog.md)
- [notification-channel](notification-channel.md)
- [notify-marketing-email-queue](notify-marketing-email-queue.md)
- [provider-callback](provider-callback.md)
- [provider-chain](provider-chain.md)
- [provider-stand-in](provider-stand-in.md)
- [send-budget](send-budget.md)
- [structured-logs](structured-logs.md)
- [tenancy-invite-requested-queue](tenancy-invite-requested-queue.md)
- [transient-failure](transient-failure.md)
<!-- used-by:end -->
