---
id: auth-breach-check-skipped-total
title: auth_breach_check_skipped_total
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# auth_breach_check_skipped_total
## Definition
`auth_breach_check_skipped_total` is a counter metric. It goes up each time registration continues without a breached-password result, either because the check timed out or because it failed. Watching this counter shows how often passwords were accepted without the breach check.

## Example
The breach source is slow, so a `POST /auth/register` waits past the 800 ms timeout. The request still gets `202 {"status":"accepted"}`, and `auth_breach_check_skipped_total` goes up by 1.

## Known gaps
- The spec does not say whether the metric has labels, for example one that separates a timeout from an error.
- The spec does not say whether an alert is attached to this counter.

## Used by
<!-- used-by:start -->
- [breached-password-check](breached-password-check.md)
<!-- used-by:end -->
