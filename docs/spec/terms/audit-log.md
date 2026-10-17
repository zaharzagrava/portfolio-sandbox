---
id: audit-log
title: Audit log
kind: term
status: draft
aliases: []
defined_for: S49-job-scheduler
rules_hash: 9ebef49f4568
---
# Audit log
## Definition
The audit log is a record of [operator](operator.md) actions on jobs. When an operator retries a [`DEAD`](job-status.md) job, the system writes one audit log line next to the status change. The line lets people see later who brought a dead job back and when. That purpose is design intent (not stated in the spec).

## Example
An operator calls [`JobsAdminService.retryDead`](jobs-admin-service-retry-dead.md) on a `DEAD` job. The job becomes [`QUEUED`](job-status.md) with [`attempts = 0`](job-attempt.md), and one audit log line is written (S49.B-14).

## Known gaps
- The spec does not say where the audit log is stored or which fields a line contains.
- The spec does not say whether other admin actions, such as `cancel` or `setScheduleEnabled`, also write audit lines.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-42
- [S02](../capabilities/S02-mfa-oidc.md): R-36
- [S32](../capabilities/S32-product-search.md): R-32
- [S49](../capabilities/S49-job-scheduler.md): B-14
- [actor-id](actor-id.md)
- [auth-events-total](auth-events-total.md)
- [job-retry-outcome](job-retry-outcome.md)
- [jobs-admin-service-retry-dead](jobs-admin-service-retry-dead.md)
- [onboarding-status-history](onboarding-status-history.md)
- [operator](operator.md)
- [put-admin-search-synonyms](put-admin-search-synonyms.md)
- [rejected-operation](rejected-operation.md)
- [synonym-history](synonym-history.md)
- [synonym-rule-count](synonym-rule-count.md)
- [synonyms-unchanged-flag](synonyms-unchanged-flag.md)
<!-- used-by:end -->
