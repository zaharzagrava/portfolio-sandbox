---
id: normalize-email
title: normalizeEmail
kind: term
status: draft
aliases: [normalised address, normalised email]
defined_for: S01-auth-sessions
rules_hash: b7d0f929d2ba
---
# normalizeEmail
## Definition
`normalizeEmail` is a function in the [identity domain's password-policy file](password-problem.md). It puts an email address into a single canonical form before the system uses it. Rule S01.R-02 requires the address to be trimmed and lower-cased. Because of this, the same mailbox typed with different spacing or capitalisation maps to one account. `passwordProblem` in the same file compares a password against this normalised address.

## Example
Registering `" New@Example.COM "` creates one [`USER` account](principal.md) stored as `new@example.com` (S01.B-01). A later registration of `"NEW@example.com"` matches that account, so it gets the [byte-identical](identical-registration-response.md) response and the account is not changed (S01.B-02).

## Known gaps
- The spec does not say whether normalisation goes beyond trimming and lower-casing, for example Unicode normalisation or provider rules such as Gmail dots or `+tags`.
- Not confirmed in the code: whether login, password reset and [`findByEmail`](find-by-email.md) call `normalizeEmail`. S01.B-16 only shows that `findByEmail(" A@Example.com ")` finds A.
- The spec does not say how two simultaneous registrations end up with exactly one account. It could be a [unique constraint ↗](../sw-external-terms.md#unique-constraint) on the normalised address or something else.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-09
- [identical-registration-response](identical-registration-response.md)
- [password-problem](password-problem.md)
- [principal](principal.md)
<!-- used-by:end -->
