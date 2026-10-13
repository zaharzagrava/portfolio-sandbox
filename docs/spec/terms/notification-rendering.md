---
id: notification-rendering
title: Notification rendering
kind: term
status: draft
aliases: [render, rendered]
defined_for: S28-notifications
rules_hash: 981933d8e6b0
---
# Notification rendering
## Definition
Notification rendering turns a notification request into the text a recipient reads. It uses the request's [catalog template](catalog-template.md) and the recipient's [locale](locale.md). It happens once per recipient, at [routing time](notification-routing.md), not when each delivery is sent. Money is formatted from integer [minor units](minor-units.md) and a currency code, never from a pre-formatted string. If a request cannot be rendered, it is [dead-lettered](dead-letter-topic.md) without [side effects](side-effects.md), and the other requests in its batch continue.

## Example
An `orders` event reaches a recipient whose locale is `uk`. The router renders the text once, in Ukrainian, with the amount formatted from minor units, for example `125000` and `UAH` (illustrative). The [inbox item](inbox-item.md) and any queued e-mail, SMS or push messages are then created from that rendered result.

## Known gaps
- The spec does not say whether each channel gets its own rendered variant, such as a short SMS body or an e-mail subject. "Once per recipient" suggests a single render shared by all channels.
- The spec does not say whether a delivery held for [quiet hours](quiet-hours.md) is rendered again at its [wake instant](wake-instant.md). Because rendering happens at routing time, a locale change made after routing is probably not reflected.
- The spec does not say how secrets are kept out of the rendered inbox item but placed in the provider message (S28.R-13, S28.R-14). It only says this uses [template redaction](template-redaction.md).

## Used by
<!-- used-by:start -->
- [catalog-template](catalog-template.md)
- [dead-letter-topic](dead-letter-topic.md)
- [dedicated-confirmation-text](dedicated-confirmation-text.md)
- [generic-fallback-text](generic-fallback-text.md)
- [inbox-item](inbox-item.md)
- [locale](locale.md)
- [minor-units](minor-units.md)
- [notification-routing](notification-routing.md)
- [quiet-hours](quiet-hours.md)
- [side-effects](side-effects.md)
- [template-redaction](template-redaction.md)
- [wake-instant](wake-instant.md)
<!-- used-by:end -->
