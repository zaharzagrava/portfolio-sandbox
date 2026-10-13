---
id: phone-code-request-limit
title: Phone code request limit
kind: term
status: draft
aliases: [code requests]
defined_for: S28-notifications
rules_hash: 9f5a93807fb8
---
# Phone code request limit
## Definition
The phone code request limit caps how many verification codes one user can ask for in a [rolling period ↗](../sw-external-terms.md#sliding-window). It is part of proving phone ownership, which a user must do before turning on SMS for any category. It is separate from the failed-attempt lockout, which counts wrong codes rather than requests. Changing the phone number clears the existing verification, so the user has to request a new code.

## Example
A user asks for a code three times in one hour on the [phone-verification endpoint](phone-verification-code.md) under [`/notifications/settings`](settings-path.md). A fourth request in that same hour is refused. Each code has six digits and is valid for 10 minutes.

## Known gaps
- The spec does not say which error code or HTTP status a refused fourth request gets, or whether it sends a [retry-after hint ↗](../sw-external-terms.md#retry-after).
- The spec does not say whether the hour is a rolling window or a fixed clock hour, or whether a phone change resets the count.
- The spec does not give the exact path of the request-code endpoint, only that it sits under the settings path of `NotificationsController`.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-19
- [phone-code-lockout](phone-code-lockout.md)
- [phone-verification-code](phone-verification-code.md)
<!-- used-by:end -->
