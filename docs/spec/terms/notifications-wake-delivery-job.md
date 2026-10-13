---
id: notifications-wake-delivery-job
title: notifications.wake-delivery job
kind: term
status: draft
aliases: [notifications.wake-delivery]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# notifications.wake-delivery job
## Definition
`notifications.wake-[delivery](delivery.md)` is a scheduled job that releases a delivery whose wait is too long for the [queue delay](queue-delay.md). Each such delivery gets exactly one of these jobs. When the job runs, it checks the delivery again for [maximum age](maximum-age.md), [suppression](suppression.md) and the user's current [preference](preference-lookup.md). Only then does it hand the delivery to its [line](notification-line.md).

## Example
At 23:10 an SMS is routed to a user whose [quiet hours](quiet-hours.md) run 22:00–07:00 in `Europe/Kyiv` (illustrative values). The wait is far longer than 900 s, so one `notifications.wake-delivery` job is scheduled for 07:00 local time. At 07:00 the job finds the user has turned SMS off for that category, so the SMS is not sent.

## Known gaps
- The spec does not say what the job's [payload](job-payload-contract.md) contains, or how the "exactly one job per delivery" rule is enforced. A [job enqueue key](job-enqueue-key.md) per delivery id would fit, but this is not confirmed.
- The spec does not say which [timeline status](delivery-timeline.md) a delivery gets when the wake check drops it because of a preference change. [`expired`](delivery-timeline-expired.md) is stated only for the maximum-age case.
- Not confirmed in the code: the [entry-point line](entry-point.md) for this job has `[proof: none]`.

## Used by
<!-- used-by:start -->
- [delivery-timeline](delivery-timeline.md)
- [entry-point](entry-point.md)
- [job-enqueue-key](job-enqueue-key.md)
- [job-payload-contract](job-payload-contract.md)
- [maximum-age](maximum-age.md)
- [notification-line](notification-line.md)
- [preference-lookup](preference-lookup.md)
- [push-notification](push-notification.md)
- [queue-delay](queue-delay.md)
- [quiet-hours](quiet-hours.md)
- [suppression](suppression.md)
<!-- used-by:end -->
