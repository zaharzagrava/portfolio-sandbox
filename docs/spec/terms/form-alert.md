---
id: form-alert
title: Form alert
kind: term
status: draft
aliases: [alert]
defined_for: W01-auth-account
rules_hash: 57207937940f
---
# Form alert
## Definition
A form alert is the message box inside an auth form (sign-in, register, MFA) that shows why a submission failed. Its text comes from the [shared error catalogue](error-catalogue.md), chosen by the [error code](error-code.md) in the [problem body](exact-body-members.md). When the request was blocked by a [CSRF ↗](../sw-external-terms.md#csrf-token) or [origin check](origin-allow-list.md), the alert also offers a **Reload** button. Validation problems for a single field show under that field, not in the alert. Errors that happen outside a form, such as a failed sign-out, use a [toast](toast.md) instead.

## Example
Sign-in fails with `401 invalid_credentials`, and the alert reads "The email or password is incorrect." The password field is cleared and focused, and the e-mail is kept.
On `429 rate_limited` the alert reads "Too many sign-in attempts. Try again in {wait}." The `{wait}` part comes from `Retry-After`.

## Known gaps
- Not confirmed in the code: that `packages/web/components/auth/problem-alert.tsx#ProblemAlert` is the component behind every form alert. The spec cites it only for the rule about console output.
- The spec does not give the alert text for `503`, other `5xx` or no network. It says only that "the matching message" is shown.

## Used by
<!-- used-by:start -->
- [W03](../capabilities/W03-cart-checkout-orders.md): B-04, B-10
- [error-catalogue](error-catalogue.md)
- [error-code](error-code.md)
- [exact-body-members](exact-body-members.md)
- [origin-allow-list](origin-allow-list.md)
- [server-rendered-search](server-rendered-search.md)
- [toast](toast.md)
<!-- used-by:end -->
