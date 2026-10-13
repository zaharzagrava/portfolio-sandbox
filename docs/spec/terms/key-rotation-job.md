---
id: key-rotation-job
title: Key rotation job
kind: term
status: draft
aliases: [rotation job]
defined_for: S01-auth-sessions
rules_hash: aca7982d723d
---
# Key rotation job
## Definition
The key rotation job is the scheduled job `auth.rotate-signing-keys`. It moves [signing keys](signing-key.md) through their states: [NEXT](signing-key-states.md), then ACTIVE, then [RETIRED](signing-key-states.md), then purged. It promotes a NEXT key to ACTIVE once the key has been published long enough and the current ACTIVE key is old enough. It keeps a NEXT key available, and it purges a RETIRED key after a [grace period](key-retirement-grace-period.md). Tokens signed by a RETIRED key keep verifying until that purge. The job is [safe to run concurrently or repeatedly ↗](../sw-external-terms.md#idempotency): it always ends with one ACTIVE and one NEXT key, and a repeated run changes nothing. It runs daily and does not run at boot.

Publishing NEXT before using it means verifiers that cache the [JWKS ↗](../sw-external-terms.md#jwks) already hold the key when it starts signing. That reason is design intent (not stated in the spec).

## Example
Key A is ACTIVE and 7 days old. Key B has been NEXT, and therefore listed in the JWKS, for 24 h. The daily run makes B ACTIVE, retires A and creates a new NEXT key C. Tokens signed by A still verify until A is purged 24 h after retirement.

## Known gaps
- The spec does not say what time of day the job runs. It also does not say what happens to key ages if the schedule is disabled through `POST /admin/job-schedules/:name/disable`.
- Not confirmed in the code: how the first ACTIVE key appears on an empty store, given that the job does not run at boot. S01.R-33 only says first uses that race must still create exactly one ACTIVE key.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-34, B-23
- [key-retirement-grace-period](key-retirement-grace-period.md)
- [reset-token-jobs](reset-token-jobs.md)
- [signing-key-states](signing-key-states.md)
- [signing-key-store](signing-key-store.md)
- [signing-key](signing-key.md)
<!-- used-by:end -->
