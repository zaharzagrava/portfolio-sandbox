---
id: phone-not-verified
title: phone_not_verified (422)
kind: term
status: draft
aliases: [phone_not_verified]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# phone_not_verified (422)
## Definition
`phone_not_verified` is the 422 error returned when a caller tries to enable [SMS](notification-channel.md) for any [category](notification-category.md) while the user has no [verified phone](verified-phone.md). It enforces the rule that only a proven phone can receive SMS.

## Example
[`PUT /notifications/preferences`](put-notifications-preferences.md) turns on SMS for one category, but the user has never verified a phone. The answer is `422 phone_not_verified`.

## Known gaps
- The spec does not say whether the other changes in the same write are rejected along with the SMS change, or saved.
- The spec does not say whether this error also covers a phone whose verification was cleared by a number change. The rule suggests it does, but the spec does not state it.

## Used by
<!-- used-by:start -->
- [notification-category](notification-category.md)
- [notification-channel](notification-channel.md)
- [verified-phone](verified-phone.md)
<!-- used-by:end -->
