---
id: invalid-schedule-error
title: InvalidScheduleError
kind: term
status: draft
aliases: []
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# InvalidScheduleError
## Definition
`InvalidScheduleError` is the error [`upsertSchedule`](upsert-schedule.md) throws when a [schedule definition](cron-schedule-materialisation.md) is not valid. It covers an invalid [cron expression ↗](../sw-external-terms.md#cron-expression), an unknown time zone, [a job type with no registered handler](job-type-registry.md), [a payload that breaks the type's contract](job-payload-contract.md), a bad schedule name, and a [`maxAttempts`](job-max-attempts.md) value outside the allowed range. It is how a domain finds out that its recurring work was never registered.

## Example
A domain calls `upsertSchedule` at boot with the cron `0 9 * * *` and the zone `Europe/Warsaw`. Its `maxAttempts` is set to `30`, which is outside 1–25. The call fails with `InvalidScheduleError`.

## Known gaps
- The spec does not say whether the error reports which check failed, or what fields it has.
- The spec does not say what makes a schedule name "bad", so the allowed name format is unknown.
- The spec does not say whether a failed `upsertSchedule` leaves an existing schedule with the same name unchanged. Leaving it unchanged would be the safe reading, but that is design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [cron-schedule-materialisation](cron-schedule-materialisation.md)
- [job-payload-contract](job-payload-contract.md)
- [job-type-registry](job-type-registry.md)
<!-- used-by:end -->
