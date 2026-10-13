---
id: mfa-not-enabled
title: mfa_not_enabled (409)
kind: term
status: draft
aliases: [mfa_not_enabled]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# mfa_not_enabled (409)
## Definition
`mfa_not_enabled` is the [conflict error](conflict-error.md) that the [disable endpoint](mfa-management-endpoint.md) returns when the caller's [second factor](second-factor-model.md) is not in the [`enabled` state](mfa-state.md). It appears when two disable requests race with the same code. The first one removes the factor, and the second one then finds no enabled factor to remove. Nothing changes because of the losing request, and it emits no event.

## Example
Two `POST /auth/mfa/disable` requests are sent at the same moment with the same [TOTP code ↗](../sw-external-terms.md#totp). One request gets `204`. The other gets:
```
HTTP/1.1 409 Conflict
{"code": "mfa_not_enabled", ...}
```

## Known gaps
- The spec does not say whether a disable call in state `none` or `pending` also gets `409 mfa_not_enabled`. The rule only requires state `enabled`, and it names this error only for the concurrent case.
- The spec does not say which error a [regenerate call](mfa-recovery-code-regenerate.md) gets outside state `enabled`.

## Used by
<!-- used-by:start -->
- [conflict-error](conflict-error.md)
- [mfa-management-endpoint](mfa-management-endpoint.md)
- [mfa-recovery-code-regenerate](mfa-recovery-code-regenerate.md)
- [mfa-state](mfa-state.md)
- [second-factor-model](second-factor-model.md)
<!-- used-by:end -->
