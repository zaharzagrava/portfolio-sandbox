---
id: wake-instant
title: Wake instant
kind: term
status: draft
aliases: [wake]
defined_for: S28-notifications
rules_hash: 5012edb091f9
---
# Wake instant
## Definition
The wake instant is the moment a delivery held for [quiet hours](quiet-hours.md) is due to continue. It is the end of the recipient's quiet-hours window, computed with the [injected clock](injected-clock.md). At that moment the delivery is checked again for [maximum age](maximum-age.md), [suppression](suppression.md) and the user's current preference. Only then is it sent.

## Example
A push delivery held overnight wakes at 07:00 (illustrative). Its event is now older than the maximum age of its type, so the delivery is recorded [`expired`](pre-send-terminal-status.md) and is not sent. The [inbox item](inbox-item.md) created at routing time stays.

## Known gaps
- The spec does not say whether quiet hours are checked again at the wake instant. If the user moved their window during the delay, the rules only list age, suppression and preference.
- Not confirmed in the code: the code reference covers only [`quietHoursEnd`](quiet-hours.md). It is not confirmed how the wake instant is stored on the delivery or on its scheduled job.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-06, R-27
- [address-suppression](address-suppression.md)
- [delivery-maximum-age](delivery-maximum-age.md)
- [delivery-suppression](delivery-suppression.md)
- [inbox-item](inbox-item.md)
- [injected-clock](injected-clock.md)
- [maximum-age](maximum-age.md)
- [notification-rendering](notification-rendering.md)
- [notify-push](notify-push.md)
- [preference-lookup](preference-lookup.md)
- [quiet-hours](quiet-hours.md)
- [suppression](suppression.md)
<!-- used-by:end -->
