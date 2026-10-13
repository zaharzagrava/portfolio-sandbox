---
id: delivery-suppression
title: Delivery suppression
kind: term
status: draft
aliases: [suppressed]
defined_for: S28-notifications
rules_hash: e82d7bf97937
---
# Delivery suppression
## Definition
[Suppression](suppression.md) is the platform's record of destinations that must never receive another [external delivery](notification-delivery.md). A [permanent provider failure](permanent-error.md) adds the address to it, so a bad address stops getting mail for good. Suppression is checked when routing, at a delayed delivery's [wake instant](wake-instant.md), and before every send. [Mandatory types](mandatory-notification-type.md) and invitations sent to a bare e-mail address are still blocked by it. A blocked delivery gets the [timeline status](delivery-timeline.md) `suppressed`.

## Example
SES reports a [permanent bounce](bounce.md) for `ana@example.com` on `POST /notifications/webhooks/ses` (illustrative address). The address is suppressed and that delivery is marked `failed`. A later order e-mail to the same address is recorded `suppressed`, and its [inbox item](inbox-item.md) is still created.

## Known gaps
- The spec does not say how an address is removed from suppression, or whether it is ever removed.
- The spec does not say whether a [`complained` callback](complaint.md) also suppresses the address. Only permanent failures are stated to do so.
- The spec does not say whether suppression covers phone numbers for SMS. For push, a [dead token](dead-push-token.md) is removed rather than suppressed.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-27
- [bounce](bounce.md)
- [complaint](complaint.md)
- [dead-push-token](dead-push-token.md)
- [delivery-timeline](delivery-timeline.md)
- [inbox-item](inbox-item.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [notification-delivery](notification-delivery.md)
- [permanent-error](permanent-error.md)
- [suppression](suppression.md)
- [wake-instant](wake-instant.md)
<!-- used-by:end -->
