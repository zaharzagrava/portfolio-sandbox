---
id: device-listing
title: Device listing
kind: term
status: draft
aliases: [lists no device]
defined_for: S28-notifications
rules_hash: e4c21ecc76fe
---
# Device listing
## Definition
The device listing is the answer of `GET /notifications/devices`. It shows the caller's [registered push devices](device-registration.md). It shows only devices the caller owns and never includes [the device token](device-token.md). If a token moved to another user, [the device leaves the first user's listing](device-ownership.md). When a user registers more devices than allowed, the oldest one is [evicted](device-cap.md) and leaves the listing too. To remove a device, call `DELETE /notifications/devices/:deviceId` with a device id that the caller owns.

## Example
Alice's listing shows her phone. Bob then registers that phone's token, and Alice's `GET /notifications/devices` no longer lists it. Bob's listing now does. (The users and the phone are illustrative.)

## Known gaps
- The spec does not say which fields each listed device has, apart from the device id used for removal.
- The spec does not say the order of the listing or whether it is [paginated](pagination-cursor.md).
- The spec does not say what `DELETE` returns for a device id that does not exist or belongs to someone else.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-14
- [device-cap](device-cap.md)
- [device-ownership](device-ownership.md)
- [device-registration](device-registration.md)
- [device-token](device-token.md)
- [pagination-cursor](pagination-cursor.md)
<!-- used-by:end -->
