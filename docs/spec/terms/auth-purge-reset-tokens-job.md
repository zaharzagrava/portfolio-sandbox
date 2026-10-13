---
id: auth-purge-reset-tokens-job
title: auth.purge-reset-tokens job
kind: term
status: draft
aliases: [auth.purge-reset-tokens]
defined_for: S01-auth-sessions
rules_hash: 0d3fbec03919
---
# auth.purge-reset-tokens job
## Definition
`auth.purge-reset-tokens` is a [scheduled job](job.md) in the identity domain that clears out stored [password reset token](password-reset-token.md) records. The scheduler runs it on a fixed [cron schedule ↗](../sw-external-terms.md#cron-expression), and it is declared in [`ResetTokenJobs`](reset-token-jobs.md). Reset tokens are single-use, so a used token, an expired token or a token replaced by a newer link no longer has any purpose. The job keeps those records from piling up in the store. This reason is design intent (not stated in the spec).

## Example
The job is registered under the [schedule name](upsert-schedule.md) `auth.purge-reset-tokens` and runs once a day. An [ADMIN operator](operator.md) can pause it and resume it through the [`core` operator routes](operator.md):
```
POST /admin/job-schedules/auth.purge-reset-tokens/disable
POST /admin/job-schedules/auth.purge-reset-tokens/enable
```
Code: `packages/backend/libs/domains/identity/infra/jobs/reset-token.jobs.ts#ResetTokenJobs`

## Known gaps
- The spec does not say which records the job deletes (expired, used, replaced by a newer link, or a mix) or how long a record is kept before deletion.
- The spec does not say whether the job runs at boot. It only says that [`auth.rotate-signing-keys`](key-rotation-job.md) does not run at boot.
- The spec does not say whether [skipped or failed runs](cron-fires-skipped-total.md) have any effect on reset tokens. Validity is presumably checked when the token is used, but that is not confirmed.

## Used by
<!-- used-by:start -->
- [cron-fires-skipped-total](cron-fires-skipped-total.md)
- [job](job.md)
- [operator](operator.md)
- [password-reset-token](password-reset-token.md)
- [reset-token-jobs](reset-token-jobs.md)
- [upsert-schedule](upsert-schedule.md)
<!-- used-by:end -->
