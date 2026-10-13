---
id: phone-code-lockout
title: Phone code lockout
kind: term
status: draft
aliases: [locking, lockout]
defined_for: S28-notifications
rules_hash: 9715be3ae043
---
# Phone code lockout
## Definition
Phone code lockout is a temporary block on [phone verification](verified-phone.md). It starts after too many wrong codes have been entered. While it lasts, the user cannot verify the phone, even with the right code. A separate [hourly limit](phone-code-request-limit.md) caps how many codes can be requested. Together these limits stop attackers from guessing codes by [brute force ↗](../sw-external-terms.md#brute-force-attack) and from flooding the phone with SMS. That reason is design intent (not stated in the spec).

## Example
A user enters a wrong six-digit code 5 times. For the next 15 minutes, verification attempts are refused. Separately, a 4th code request within the same hour is also refused, because the limit is 3 requests per hour.

## Known gaps
- The spec does not say which [error code](error-code.md) or status a locked or over-limit request returns.
- The spec does not say whether requesting a new code or changing the phone ends an active lockout.
- The spec does not say whether the hourly request limit is a [rolling window ↗](../sw-external-terms.md#sliding-window) or a fixed one.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-19
- [error-code](error-code.md)
- [phone-code-request-limit](phone-code-request-limit.md)
- [verified-phone](verified-phone.md)
<!-- used-by:end -->
