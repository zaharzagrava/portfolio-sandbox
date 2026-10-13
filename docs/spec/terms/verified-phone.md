---
id: verified-phone
title: Verified phone
kind: term
status: draft
aliases: [phone verification]
defined_for: S28-notifications
rules_hash: b2a0079ba153
---
# Verified phone
## Definition
A verified phone is a phone number whose ownership the user has proven with a [one-time code](phone-verification-code.md) sent to it. SMS can only be enabled for a [category](notification-category.md) once the phone is verified. Changing the phone number clears the verification, so the new number must be proven again. Responses never show the full number, only a masked version.

## Example
1. The user requests a code through the phone-verification endpoint under the [settings path](settings-path.md).
2. They enter the six-digit code before it expires, and the phone becomes verified.
3. After that, [`PUT /notifications/preferences`](put-notifications-preferences.md) with SMS enabled for a category succeeds.

## Known gaps
- The spec does not say the exact paths of the request-code and verify-code endpoints. It only says they are under the settings path.
- The spec does not say what happens to [SMS preferences](preference-matrix.md) that are already on when the phone changes and loses its verification.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-18, R-19
- [masked-phone](masked-phone.md)
- [notification-category](notification-category.md)
- [notification-channel](notification-channel.md)
- [notifications-controller](notifications-controller.md)
- [phone-code-lockout](phone-code-lockout.md)
- [phone-not-verified](phone-not-verified.md)
- [phone-verification-code](phone-verification-code.md)
- [preference-matrix](preference-matrix.md)
- [put-notifications-preferences](put-notifications-preferences.md)
- [settings-path](settings-path.md)
<!-- used-by:end -->
