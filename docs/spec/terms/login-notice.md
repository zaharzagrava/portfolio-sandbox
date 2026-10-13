---
id: login-notice
title: Login notice parameter
kind: term
status: draft
aliases: [notice, notice=registered]
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# Login notice parameter
## Definition
`notice` is a [query parameter ↗](../sw-external-terms.md#query-string) on `/login`. It tells the sign-in page to show an informational banner about what just happened. Other flows set it when they send the browser to `/login`, for example after registering or after signing out. `/login` reads it together with [`returnTo`](return-to.md) and `error`. Design intent (not stated in the spec): it carries a one-time message across a page change without keeping any client state.

## Example
After a successful registration the browser goes to `/login?notice=registered`. After a successful logout it goes to `/login?notice=signed_out`.

## Known gaps
- The spec does not list every allowed `notice` value or the banner text for each one.
- The spec does not say what `/login` does with an unknown `notice` value.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
