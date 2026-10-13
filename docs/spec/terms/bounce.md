---
id: bounce
title: Bounce
kind: term
status: draft
aliases: [bounced, permanent bounce]
defined_for: S28-notifications
rules_hash: beccd59e63cb
---
# Bounce
## Definition
A bounce is a [provider callback](provider-callback.md) saying that an e-mail could not be delivered to its address. A permanent bounce (the address does not exist or will never accept mail) [suppresses the address](address-suppression.md), so no further e-mail goes to it. That includes [mandatory types](mandatory-notification-type.md). [The delivery's timeline](delivery-timeline.md) records the status `bounced`. A bounce arrives as a callback after the send. It is separate from a [permanent provider failure](permanent-error.md) during the send, which also suppresses the address but marks the delivery `failed`.

## Example
An invitation e-mail is sent to `typo@exmaple.com` (illustrative). [SES ↗](../sw-external-terms.md#amazon-ses) later reports a permanent bounce through `POST /notifications/webhooks/ses`. The address is suppressed, and the timeline for that delivery shows `bounced`.

## Known gaps
- The spec does not say what happens on a temporary (soft) bounce. Only permanent bounces are covered.
- The spec does not say how the platform tells a permanent bounce from a temporary one in the provider's payload.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-46
- [address-suppression](address-suppression.md)
- [delivery-suppression](delivery-suppression.md)
- [delivery-timeline](delivery-timeline.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [permanent-error](permanent-error.md)
- [provider-callback](provider-callback.md)
<!-- used-by:end -->
