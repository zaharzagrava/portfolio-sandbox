---
id: reset-token-jobs
title: ResetTokenJobs
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# ResetTokenJobs
## Definition
`ResetTokenJobs` is the class in the [identity domain's infra layer](infrastructure-layer.md) that declares the [auth.purge-reset-tokens job](auth-purge-reset-tokens-job.md). That job is a [scheduled job](job.md), and it clears out stored [password reset token](password-reset-token.md) records. The class only registers the job with the scheduler. The [scheduler leader](scheduler-leader.md) decides when the job fires, and operators can enable or disable its schedule. It sits next to `KeyRotationJobs`, which declares the [signing key rotation job](key-rotation-job.md) in the same way.

## Example
The job runs daily under the schedule name `auth.purge-reset-tokens`. An ADMIN can switch it off and on again through the [operator routes](operator.md) hosted by `core`:
```
POST /admin/job-schedules/auth.purge-reset-tokens/disable
POST /admin/job-schedules/auth.purge-reset-tokens/enable
```
Code: `packages/backend/libs/domains/identity/infra/jobs/reset-token.jobs.ts#ResetTokenJobs`

## Known gaps
- The spec does not say which reset token records the job deletes (expired, used or replaced ones) or how long a record is kept first.
- The spec does not say whether this job runs at boot. It says only that `auth.rotate-signing-keys` does not.
- Not confirmed in the code: whether `ResetTokenJobs` declares any job other than `auth.purge-reset-tokens`.

## Used by
<!-- used-by:start -->
- [auth-purge-reset-tokens-job](auth-purge-reset-tokens-job.md)
- [infrastructure-layer](infrastructure-layer.md)
- [job](job.md)
- [key-rotation-job](key-rotation-job.md)
- [operator](operator.md)
- [password-reset-token](password-reset-token.md)
- [scheduler-leader](scheduler-leader.md)
<!-- used-by:end -->
