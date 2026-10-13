---
id: operator
title: Operator
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: 47ee3fc3ea30
---
# Operator
## Definition
An operator is a person who runs the system in production, not a component of it. In this capability, an operator can manually set the [version pointer](version-pointer.md) back to an older published version of the suggestion data, for example after a bad build. The serving machines must follow the pointer backwards as they follow it forwards. A manual rollback is the only way the pointer moves backwards, because the process that builds new versions only moves it forwards.

## Example
`V6` contains bad suggestions, so an operator sets the pointer back to `V5` (illustrative versions). On their next poll, every node loads [`autocomplete/V5`](autocomplete-object.md) and serves it.

## Known gaps
- The spec does not say what tool, command or permission an operator uses to change the pointer.
- The spec does not say how a manual rollback interacts with the next hourly build. The builder only checks that its version is greater than the pointer, so the next build would likely replace the rollback.
- Rollback only works to a version that still exists. The spec keeps only the latest five versions.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-24
- [S49](../capabilities/S49-job-scheduler.md): B-14
- [S53](../capabilities/S53-events-projections.md): B-14
- [audit-log](audit-log.md)
- [autocomplete-blocklist](autocomplete-blocklist.md)
- [autocomplete-pointer](autocomplete-pointer.md)
- [blocked-host](blocked-host.md)
- [dead-letter-redrive](dead-letter-redrive.md)
- [failure-counter](failure-counter.md)
- [health-check-up](health-check-up.md)
- [job-last-error](job-last-error.md)
- [jobs-admin-service-retry-dead](jobs-admin-service-retry-dead.md)
- [node](node.md)
- [non-retryable-broker-error](non-retryable-broker-error.md)
- [published-version](published-version.md)
- [schedule-auto-disable](schedule-auto-disable.md)
- [schedule-enabled](schedule-enabled.md)
- [serve-time](serve-time.md)
- [snapshot](snapshot.md)
- [suggest-builder](suggest-builder.md)
- [superseded-build](superseded-build.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
