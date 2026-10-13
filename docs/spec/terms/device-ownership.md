---
id: device-ownership
title: Device ownership
kind: term
status: draft
aliases: [only by its owner, owner only]
defined_for: S28-notifications
rules_hash: 09dc2910345e
---
# Device ownership
## Definition
Device ownership says which user a registered [push device](device-registration.md) belongs to. It is always the user who registered the [device token](device-token.md) most recently. If a known token is registered again by another user, ownership moves to that user. Only the owner can remove a device, and only by its [device id](device-registration.md), never by its token. Design intent (not stated in the spec): when a phone changes hands, [pushes](push-notification.md) follow the person now signed in, and the token never has to leave the server.

## Example
User A registers a phone. Later user B signs in on the same phone, and the app sends the same token to [`POST /notifications/devices`](device-registration.md). The device now belongs to B, so A's pushes stop going to that phone. If A then calls `DELETE /notifications/devices/:deviceId` with that device's id, the device is not removed, because A is no longer the owner.

## Known gaps
- The spec does not say what a non-owner gets when deleting someone else's device. It could be a 404 (which hides that the device exists) or a 403.
- The spec does not say whether the previous owner is told when ownership moves, or whether the device id stays the same or a new one is issued.
- The spec does not say directly that `GET /notifications/devices` is limited to the caller's own devices. The owner-only rule is stated only for removal.

## Used by
<!-- used-by:start -->
- [device-listing](device-listing.md)
- [device-registration](device-registration.md)
- [device-token](device-token.md)
- [push-notification](push-notification.md)
<!-- used-by:end -->
