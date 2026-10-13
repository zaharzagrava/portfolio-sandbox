---
id: dead-push-token
title: Dead push token
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 38c92da65460
---
# Dead push token
## Definition
A dead push token belongs to a registered [push device](device-registration.md), and the [push provider](payment-provider.md) has said permanently that it can no longer receive messages. This usually happens because the app was removed or the token was replaced. When a send gets this [permanent error](permanent-error.md), the worker removes the token. It does not [fail over to another provider](fallback-provider.md) and does not retry, and the delivery is recorded as [`failed`](delivery-status.md). Removing the token stops later pushes from going to a device that cannot receive them. That reason is design intent (not stated in the spec).

## Example
The user has a device registered through `POST /notifications/devices`. A push send gets a permanent "unregistered token" answer from the provider (illustrative wording). The token is removed, so the device no longer appears in `GET /notifications/devices`, and the delivery's [timeline](delivery-timeline.md) ends in `failed`.

## Known gaps
- The spec does not say whether the whole device record is deleted or only its token is cleared.
- The spec does not say which provider answers mark a token as dead.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-33
- [delivery-suppression](delivery-suppression.md)
- [delivery-timeline](delivery-timeline.md)
- [device-registration](device-registration.md)
- [fallback-provider](fallback-provider.md)
- [payment-provider](payment-provider.md)
- [permanent-error](permanent-error.md)
- [suppression](suppression.md)
<!-- used-by:end -->
