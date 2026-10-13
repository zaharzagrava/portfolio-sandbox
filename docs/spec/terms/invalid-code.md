---
id: invalid-code
title: invalid_code (422)
kind: term
status: draft
aliases: [invalid_code]
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# invalid_code (422)
## Definition
`invalid_code` is an error code sent with HTTP 422 when a submitted [second-step code](mfa-code.md) is rejected. On [`/login/mfa`](login-mfa-page.md), the web app handles it the same way as [`401 invalid_mfa_code`](invalid-mfa-code.md). It shows one message, then clears and focuses the code field. The message text comes from the [shared error catalogue](error-catalogue.md), which is built from the [problem body ↗](../sw-external-terms.md#problem-json).

## Example
The member types a wrong 6-digit code on `/login/mfa` and presses **Verify**. The answer is `HTTP/1.1 422` with a problem body whose code is `invalid_code`. The page shows one error message, and the code field is emptied and focused for a new attempt.

## Known gaps
- The spec does not say which service returns `422 invalid_code` rather than `401 invalid_mfa_code`, or under what condition.
- The spec does not give the message text shown for this code.

## Used by
<!-- used-by:start -->
- [error-catalogue](error-catalogue.md)
- [mfa-code](mfa-code.md)
<!-- used-by:end -->
