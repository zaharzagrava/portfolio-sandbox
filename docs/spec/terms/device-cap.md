---
id: device-cap
title: Device cap
kind: term
status: draft
aliases: [evicts their oldest device]
defined_for: S28-notifications
rules_hash: 88ed20388f9b
---
# Device cap
## Definition
The device cap is the most push devices one user may have registered at the same time. When a new device registration would go over the cap, the user's oldest device is evicted. The cap applies per user, not per [token](device-token.md), so one user's devices never push out another user's. Design intent (not stated in the spec): it keeps [push fan-out](follower-fan-out.md) per user bounded and clears out devices that have probably been abandoned.

## Example
A user already has 10 devices registered (the limit in S28.R-22). They sign in on a new tablet, and the app calls `POST /notifications/devices`. The tablet is registered and their oldest device is evicted. `GET /notifications/devices` still lists 10 devices.

## Known gaps
- The spec does not say what "oldest" means: first registration time, or the time of the most recent registration or use.
- The spec does not say whether a known token that moves to this user counts as a new registration that can evict one of their devices, or whether re-registering a token they already have resets its age.
- The spec does not say whether an evicted device or its user is told. Pushes to that device just stop.

## Used by
<!-- used-by:start -->
- [device-listing](device-listing.md)
- [device-registration](device-registration.md)
- [device-token](device-token.md)
- [follower-fan-out](follower-fan-out.md)
<!-- used-by:end -->
