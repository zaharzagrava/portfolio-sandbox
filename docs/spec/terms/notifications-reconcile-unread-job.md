---
id: notifications-reconcile-unread-job
title: notifications.reconcile-unread job
kind: term
status: draft
aliases: [notifications.reconcile-unread]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# notifications.reconcile-unread job
## Definition
`notifications.reconcile-unread` is a [scheduled job](job.md) owned by the notifications capability. The spec lists it among the capability's [entry points](entry-point.md) but gives no proof for it and does not describe what it does. Its name suggests it performs [unread count](unread-count.md) repair. That repair brings a user's unread count back in line with their unread [inbox items](inbox-item.md) after a crash between the two writes. This link to the repair is a guess from the name, not something the spec states.

## Example
A worker writes a new inbox item for user `u-42` (illustrative) and crashes before it updates the count. The [notification bell](notification-bell.md) shows 4, but the inbox holds 5 unread items. Rule S28.R-39 requires the count to read 5 again within 5 minutes. This job is the likely way that happens, but that is not confirmed.

## Known gaps
- Not confirmed in the code: that this job performs unread count repair. Its entry point is marked "[proof: none](rule-proof.md)", so only its name suggests what it does.
- The spec does not say how often the job runs, or whether it checks every user or only users affected by a crash.
- The spec does not say whether this job also rebuilds the unread count after its whole store is lost. Rule S28.R-39 requires that rebuild but names no mechanism for it.

## Used by
<!-- used-by:start -->
- [entry-point](entry-point.md)
- [inbox-item](inbox-item.md)
- [job](job.md)
- [notification-bell](notification-bell.md)
- [rule-proof](rule-proof.md)
- [unread-count](unread-count.md)
<!-- used-by:end -->
