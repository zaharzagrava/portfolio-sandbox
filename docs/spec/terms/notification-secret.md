---
id: notification-secret
title: NOTIFICATION_SECRET
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# NOTIFICATION_SECRET
## Definition
`NOTIFICATION_SECRET` is the secret configuration value of the [notifications capability](capability.md). In production, [startup fails](startup-validation.md) if it is missing or has the same value as another secret. Design intent (not stated in the spec): a separate secret limits the damage if one secret leaks, and stops a token signed for one purpose from being accepted for another.

## Example
A production deployment sets `NOTIFICATION_SECRET` to the same value as another platform secret. Startup fails with a configuration error and the process does not start serving.

## Known gaps
- Not confirmed in the code: which signatures use this secret. Likely candidates are the [unsubscribe tokens](unsubscribe-token.md) and the [inbox cursors](pagination-cursor.md), which the spec only calls "signed".
- The spec does not say how to [rotate ↗](../sw-external-terms.md#key-rotation) this secret. Rotating it would affect unsubscribe tokens, which never expire and are already in people's mailboxes.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [pagination-cursor](pagination-cursor.md)
- [startup-validation](startup-validation.md)
- [unsubscribe-token](unsubscribe-token.md)
<!-- used-by:end -->
