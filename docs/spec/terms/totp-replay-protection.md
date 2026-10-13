---
id: totp-replay-protection
title: TOTP replay protection
kind: term
status: draft
aliases: [replay, replayed code]
defined_for: S02-mfa-oidc
rules_hash: 9b8a8eb61691
---
# TOTP replay protection
## Definition
TOTP replay protection means a [TOTP code ↗](../sw-external-terms.md#totp) that was already accepted cannot be accepted again. After each success the system stores the accepted [TOTP step](totp-time-step.md) with a [durable conditional write](guarded-update.md) in the database, not in a cache. A cache flush or a restart therefore cannot reopen a spent code. The design decision states this reason directly.

## Example
Alice's code is accepted at step T during one login. An attacker who captured the code replays it in a second login, even after the cache was flushed and the service restarted. They get [`401 invalid_mfa_code`](invalid-mfa-code.md).

## Known gaps
- Not confirmed in the code: which table or column holds the last accepted step. It is probably on [`SecondFactor`](mfa-state.md), but the spec does not name it.
- The spec does not say whether confirm, regenerate and disable also advance the stored step, or only login verify does.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-09
- [durable-conditional-write](durable-conditional-write.md)
- [guarded-update](guarded-update.md)
- [invalid-mfa-code](invalid-mfa-code.md)
- [mfa-code](mfa-code.md)
- [second-factor-model](second-factor-model.md)
- [totp-time-step](totp-time-step.md)
- [verify-totp](verify-totp.md)
<!-- used-by:end -->
