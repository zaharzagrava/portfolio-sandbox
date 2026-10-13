---
id: delivery-timeline
title: Delivery timeline
kind: term
status: draft
aliases: [timeline]
defined_for: S28-notifications
rules_hash: ddcf03fd605e
---
# Delivery timeline
## Definition
The [delivery](delivery.md) timeline is the status history of a single delivery on one [channel](notification-channel.md). The status names are listed in S28.R-12. It records where the delivery is now: waiting, sent, [confirmed by the provider](delivery-status.md), [refused by a rule](pre-send-terminal-status.md), or ended in failure. If writing to the timeline fails, the send itself must not fail and must not be repeated. Secrets such as reset tokens, one-time codes and [unsubscribe tokens](unsubscribe-token.md) never appear in it.

## Example
A push delivery held for [quiet hours](quiet-hours.md) might read:
```
queued → delayed → sent → delivered
```
If the delivery had passed its type's [maximum age](maximum-age.md) before it woke, it would end at `expired` instead.

## Known gaps
- The spec does not say where the timeline is stored, how long it is kept, or whether any endpoint exposes it.
- The spec does not list the legal transitions between statuses. For example, it does not say whether `skipped` can follow `delayed`.
- No [acceptance scenario](acceptance-scenario.md) backs this rule (S28.R-12 is `[proof: none]`).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-12, B-09
- [acceptance-scenario](acceptance-scenario.md)
- [address-suppression](address-suppression.md)
- [bounce](bounce.md)
- [bounded-label-values](bounded-label-values.md)
- [callback-deduplication](callback-deduplication.md)
- [capped-delivery](capped-delivery.md)
- [complaint](complaint.md)
- [contact-data](contact-data.md)
- [dead-push-token](dead-push-token.md)
- [delivery-bounced](delivery-bounced.md)
- [delivery-capped](delivery-capped.md)
- [delivery-maximum-age](delivery-maximum-age.md)
- [delivery-status](delivery-status.md)
- [delivery-suppression](delivery-suppression.md)
- [delivery-timeline-expired](delivery-timeline-expired.md)
- [delivery](delivery.md)
- [durable-acceptance](durable-acceptance.md)
- [exhausted](exhausted.md)
- [failover-timeline-entry](failover-timeline-entry.md)
- [fallback-provider](fallback-provider.md)
- [get-dev-mailbox](get-dev-mailbox.md)
- [in-memory-mailbox](in-memory-mailbox.md)
- [log-provider](log-provider.md)
- [maximum-age](maximum-age.md)
- [notification-channel](notification-channel.md)
- [notification-delivery](notification-delivery.md)
- [notification-maximum-age](notification-maximum-age.md)
- [notification-queue](notification-queue.md)
- [notification-webhooks-controller](notification-webhooks-controller.md)
- [notifications-wake-delivery-job](notifications-wake-delivery-job.md)
- [password-reset-mailer-port](password-reset-mailer-port.md)
- [post-notifications-webhooks-twilio](post-notifications-webhooks-twilio.md)
- [pre-send-terminal-status](pre-send-terminal-status.md)
- [preference-lookup](preference-lookup.md)
- [provider-stand-in](provider-stand-in.md)
- [queue-refusal](queue-refusal.md)
- [quiet-hours](quiet-hours.md)
- [ses-complaint](ses-complaint.md)
- [suppression](suppression.md)
- [template-redaction](template-redaction.md)
- [tenancy-invite-requested-queue](tenancy-invite-requested-queue.md)
- [transactional-mail-module](transactional-mail-module.md)
- [transient-error](transient-error.md)
- [unsubscribe-token](unsubscribe-token.md)
<!-- used-by:end -->
