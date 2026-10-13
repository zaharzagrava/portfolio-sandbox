---
id: explicit-override
title: Explicit override
kind: term
status: draft
aliases: [override]
defined_for: S28-notifications
rules_hash: 28e75b1d0941
---
# Explicit override
## Definition
An explicit override is a value the user has actually stored in a cell of the preference matrix. A stored value always wins over the default for that [category and channel](notification-channel.md). An empty cell uses the default instead, for example "off" for [marketing external channels](marketing-external-channels.md) and SMS. A consequence of the rule: changing a default later only affects users who never stored that cell.

## Example
A user stores `true` for [marketing e-mail](marketing-email.md). That is an explicit override, so they receive marketing e-mails even though the default is off. Their marketing push cell is still empty, so it stays at the default: off.

## Known gaps
- The spec does not say whether writing a value equal to the default stores an override or leaves the cell empty.
- The spec does not describe any way to clear an override and go back to the default.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-15
- [marketing-email](marketing-email.md)
- [marketing-external-channels](marketing-external-channels.md)
- [notification-channel](notification-channel.md)
- [opt-out](opt-out.md)
- [post-notifications-unsubscribe](post-notifications-unsubscribe.md)
- [preference-matrix](preference-matrix.md)
- [put-notifications-preferences](put-notifications-preferences.md)
<!-- used-by:end -->
