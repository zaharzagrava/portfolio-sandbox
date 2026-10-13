---
id: device-token
title: Device token
kind: term
status: draft
aliases: [registered token, token]
defined_for: S28-notifications
rules_hash: 98d51cb92c17
---
# Device token
## Definition
A device token is the push address of one device. A user registers it through `POST /notifications/devices` so the [push line](notification-channel.md) can reach that device. One token belongs to one user at a time: if another user registers a known token, the token moves to that latest user. The system never returns the token in any answer. When a provider reports a [permanent failure](permanent-error.md) for a token, the token is removed as dead.

## Example
Alice registers her phone's token, and the phone then signs in as Bob, who registers the same token. The token now belongs to Bob. Push notifications for Alice no longer go to that phone. (The users and the phone are illustrative.)

## Known gaps
- The spec does not say the token format or which push provider issues it.
- The spec does not say what happens when two users register the same token at the same time.
- The spec does not list device tokens among the secrets that must stay out of logs, timeline, metrics and [dead-letter records](dead-letter-topic.md).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-14
- [dead-letter-topic](dead-letter-topic.md)
- [device-cap](device-cap.md)
- [device-listing](device-listing.md)
- [device-ownership](device-ownership.md)
- [device-registration](device-registration.md)
- [notification-channel](notification-channel.md)
- [permanent-error](permanent-error.md)
<!-- used-by:end -->
