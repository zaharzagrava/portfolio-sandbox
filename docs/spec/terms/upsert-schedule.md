---
id: upsert-schedule
title: upsertSchedule
kind: term
status: draft
aliases: [upsert schedule]
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# upsertSchedule
## Definition
`upsertSchedule` registers a [recurring schedule](cron-schedule-materialisation.md), or changes one that already exists. The call creates the row if the name is new and updates it otherwise. That means [every replica](worker-instance.md) can safely call it at boot with the same definition. The call validates the definition and fails with [`InvalidScheduleError`](invalid-schedule-error.md) when the [cron ↗](../sw-external-terms.md#cron-expression), zone, job type, payload, name or [`maxAttempts`](job-max-attempts.md) is invalid. `removeSchedule` is its counterpart for deleting a schedule.

## Example
8 replicas each call `upsertSchedule` at boot with a `0 9 * * *` Europe/Warsaw definition. All 8 calls succeed, and one schedule row exists (S49.B-17).

## Known gaps
- The spec does not list the exact parameters, such as whether the [overlap policy](cron-overlap-policy.md) and `enabled` are part of the definition.
- The spec does not say whether changing a definition recomputes the next fire, or whether an upsert re-enables a schedule that was auto-disabled after failing ticks.
- Not confirmed in the code: the file and symbol that implement `upsertSchedule` are not listed.

## Used by
<!-- used-by:start -->
- [cron-overlap-policy](cron-overlap-policy.md)
- [cron-schedule-materialisation](cron-schedule-materialisation.md)
- [worker-instance](worker-instance.md)
<!-- used-by:end -->
