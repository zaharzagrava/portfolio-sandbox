---
id: device-registration
title: Device registration
kind: term
status: draft
aliases: [device]
defined_for: S28-notifications
rules_hash: 8daad04bca29
---
# Device registration
## Definition
Device registration records a [push token](device-token.md) for the calling user so [push deliveries](push-notification.md) can reach that device. If the token is already known, it moves to the user who registered it most recently. Each user has a [device cap](device-cap.md): registering past it evicts their oldest device. Responses never include the token. A device can be removed only by its id and only by its owner.

## Example
```
POST   /notifications/devices            -> registers this phone's push token for the caller
GET    /notifications/devices            -> lists devices (no tokens in the answer)
DELETE /notifications/devices/:deviceId  -> removes it, [owner only](device-ownership.md)
```

## Known gaps
- The spec does not say what the request body contains (for example platform or app fields), or what "oldest" means: registration time or last use.
- The spec does not say what a non-owner gets when deleting someone else's device (a 404 or a 403).
- Separately, a [permanent provider failure](permanent-error.md) removes a [dead push token](dead-push-token.md) (S28.R-33). The user is not told when that happens.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-22
- [dead-push-token](dead-push-token.md)
- [device-cap](device-cap.md)
- [device-listing](device-listing.md)
- [device-ownership](device-ownership.md)
- [device-token](device-token.md)
- [permanent-error](permanent-error.md)
- [push-notification](push-notification.md)
<!-- used-by:end -->
