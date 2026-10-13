---
id: unsubscribe-token
title: Unsubscribe token
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 20ed5e7ce990
---
# Unsubscribe token
## Definition
The unsubscribe token is a [signed value ↗](../sw-external-terms.md#digital-signature) placed in the unsubscribe URL of every e-mail that is not of a [mandatory type](mandatory-type.md). It names one [category](notification-category.md). Posting it to [`POST /notifications/unsubscribe`](post-notifications-unsubscribe.md) switches off the [e-mail channel](notification-channel.md) for that category, and no sign-in is needed. The token does not expire. It is treated as a secret: it may appear only in the message handed to the provider. Every bad token gets the same [`400 invalid_unsubscribe_token`](invalid-unsubscribe-token.md) with no reason given.

## Example
A marketing e-mail contains a link like `/notifications/unsubscribe?token=<token>` (the token value is illustrative).
- `GET` with the token only describes what will happen.
- `POST` with the token turns off e-mail for that category.
- A token that has been tampered with gets `400 invalid_unsubscribe_token`.

## Known gaps
- The spec does not say which secret signs the token. [`NOTIFICATION_SECRET`](notification-secret.md) is a likely candidate but is not stated to be the one.
- The spec does not say how a leaked token can be revoked, since tokens never expire.
- The spec does not say what the token encodes besides the category, for example the user id.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-13, R-23
- [delivery-timeline](delivery-timeline.md)
- [invalid-unsubscribe-token](invalid-unsubscribe-token.md)
- [malformed-queue-message](malformed-queue-message.md)
- [mandatory-type](mandatory-type.md)
- [notification-category](notification-category.md)
- [notification-channel](notification-channel.md)
- [notification-secret](notification-secret.md)
- [post-notifications-unsubscribe](post-notifications-unsubscribe.md)
- [template-redaction](template-redaction.md)
- [unauthenticated-endpoint](unauthenticated-endpoint.md)
<!-- used-by:end -->
