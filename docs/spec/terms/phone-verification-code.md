---
id: phone-verification-code
title: Phone verification code
kind: term
status: draft
aliases: [code, one-time code, six-digit code]
defined_for: S28-notifications
rules_hash: 66c1faed56e1
---
# Phone verification code
## Definition
A phone verification code is the one-time code a user enters to prove they own the phone number on their [notification settings](notification-settings.md). A correct code makes the phone a verified phone, which is required before SMS can be enabled for any [category](notification-category.md). The code expires after a short validity period. Too many wrong guesses lock verification for a while, and [the number of code requests per hour is limited](phone-code-request-limit.md). The code is a secret, so it appears only in the message handed to the provider and never in logs, the timeline, metrics, dead-letter records or inbox items.

## Example
1. The user asks for a code through the request-code endpoint under the settings path. A six-digit code such as `482913` (illustrative) is sent to the phone.
2. Within 10 minutes the user submits `482913` to the verify endpoint, and the phone becomes verified.
3. If the user enters a wrong code 5 times, verification is locked for 15 minutes. A 4th code request within the same hour is refused.

## Known gaps
- The spec does not say which response a locked or rate-limited code request returns (status code or error code).
- The spec does not say whether asking for a new code invalidates a code that was already sent and is still valid.
- The spec does not say which channel or provider sends the code. It only says the code reaches the provider in the outgoing message.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-19
- [notification-category](notification-category.md)
- [notification-settings](notification-settings.md)
- [phone-code-request-limit](phone-code-request-limit.md)
- [settings-path](settings-path.md)
- [verified-phone](verified-phone.md)
<!-- used-by:end -->
