---
id: notification-type
title: Notification type
kind: term
status: draft
aliases: [type]
defined_for: S28-notifications
rules_hash: 0cb8be3b4911
---
# Notification type
## Definition
A notification type is one kind of message that the notification catalog defines. Each type has its own catalog template. The type sets the rules for one notification: how old its event may be before external sends stop, and whether it is a [mandatory type](mandatory-type.md). The [router](notification-router.md) maps each consumed event to zero or more notification requests, and each request has a type. "Notification type" is not the same as the source event's type. An event type can be a known-unmapped type that creates no notification at all.

## Example
A password-reset request produces a notification of the password-reset type. It is sent through the `PASSWORD_RESET_MAILER` port using its catalog template, and template redaction keeps the reset token out of logs and the timeline.
An invitation from the [`tenancy-invite-requested` queue](tenancy-invite-requested-queue.md) produces a type addressed to an e-mail address. It goes to the e-mail line only, with no inbox item.
Whether a type is mandatory decides whether its e-mail carries the unsubscribe link and [one-click headers ↗](../sw-external-terms.md#list-unsubscribe-one-click). A non-mandatory type carries them. A mandatory type carries neither.

## Known gaps
- The spec does not list the notification types, say which ones are mandatory, or give each type's maximum age.
- The spec does not say how a type links to its notification category, the unit that preferences and unsubscribe work on. It also does not say whether marketing versus transactional is set per type or per category.
- The spec does not say where types are declared or how a new type is added to the catalog.

## Used by
<!-- used-by:start -->
- [catalog-template](catalog-template.md)
- [mandatory-type](mandatory-type.md)
- [notification-catalog](notification-catalog.md)
- [notification-category](notification-category.md)
- [notification-router](notification-router.md)
- [tenancy-invite-requested-queue](tenancy-invite-requested-queue.md)
- [unread-count](unread-count.md)
<!-- used-by:end -->
