---
id: inbox-item
title: Inbox item
kind: term
status: draft
aliases: [inbox]
defined_for: S28-notifications
rules_hash: 73c90d91491c
---
# Inbox item
## Definition
An inbox item is the stored, per-recipient copy of a notification that the user sees through `GET /notifications` and [the bell](notification-bell.md). [The router](notification-router.md) creates it first for each recipient, before any [external channel](notification-channel.md). It stays even when the external delivery is [capped](delivery-capped.md) or expired. A new item is announced with [the realtime event `notification`](realtime-event.md) on the owner's topic [`user:<userId>`](realtime-topic.md). This is not the same thing as the [consumer-side inbox table](inbox-table.md) used for [event deduplication](consumer-deduplication-mode.md).

## Example
A payment event for buyer `u-42` (illustrative) creates one inbox item rendered in their locale. The [unread count](unread-count.md) goes up by one, and `user:u-42` receives event `notification`. Later, [`POST /notifications/read`](post-notifications-read.md) marks it read and decrements the count once.

## Known gaps
- The spec does not list the fields an inbox item holds.
- The spec does not say whether a user can opt out of inbox items through the [preference matrix](preference-matrix.md), or whether inbox items are always created.
- Invitations addressed to an e-mail address create no inbox item at all.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-02, R-13, R-28, R-41, B-01, B-05
- [auctions-source-family](auctions-source-family.md)
- [billing-source-family](billing-source-family.md)
- [capped-delivery](capped-delivery.md)
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [dedupe-identity](dedupe-identity.md)
- [delivery-capped](delivery-capped.md)
- [delivery-maximum-age](delivery-maximum-age.md)
- [delivery-suppression](delivery-suppression.md)
- [delivery-timeline-expired](delivery-timeline-expired.md)
- [done-marker](done-marker.md)
- [email-line](email-line.md)
- [exported-service](exported-service.md)
- [follower-fan-out](follower-fan-out.md)
- [get-notifications](get-notifications.md)
- [get-unread-count](get-unread-count.md)
- [inbox-table](inbox-table.md)
- [known-unmapped-type](known-unmapped-type.md)
- [mark-all-read](mark-all-read.md)
- [marketing-email](marketing-email.md)
- [maximum-age](maximum-age.md)
- [notification-bell](notification-bell.md)
- [notification-channel](notification-channel.md)
- [notification-maximum-age](notification-maximum-age.md)
- [notification-queue](notification-queue.md)
- [notification-recipient](notification-recipient.md)
- [notification-rendering](notification-rendering.md)
- [notification-router](notification-router.md)
- [notifications-reconcile-unread-job](notifications-reconcile-unread-job.md)
- [notified-version](notified-version.md)
- [notify-email-queue](notify-email-queue.md)
- [notify-marketing-push](notify-marketing-push.md)
- [outbid-event](outbid-event.md)
- [payment-confirmation-challenge](payment-confirmation-challenge.md)
- [post-notifications-read](post-notifications-read.md)
- [preference-lookup](preference-lookup.md)
- [preference-matrix](preference-matrix.md)
- [push-notification](push-notification.md)
- [queue-refusal](queue-refusal.md)
- [realtime-event](realtime-event.md)
- [recipient-rule](recipient-rule.md)
- [render-failure](render-failure.md)
- [resumable-fan-out](resumable-fan-out.md)
- [routing-step](routing-step.md)
- [side-effects](side-effects.md)
- [tampered-cursor](tampered-cursor.md)
- [template-redaction](template-redaction.md)
- [tenancy-invite-requested-queue](tenancy-invite-requested-queue.md)
- [unread-count-repair](unread-count-repair.md)
- [unread-count](unread-count.md)
- [wake-instant](wake-instant.md)
<!-- used-by:end -->
