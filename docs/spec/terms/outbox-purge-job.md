---
id: outbox-purge-job
title: Outbox purge job
kind: term
status: draft
aliases: [purge job]
defined_for: S53-events-projections
rules_hash: bb3526d8152e
---
# Outbox purge job
## Definition
The outbox purge job is a [single-run job](job.md) (see S49) that deletes old rows from the [outbox table](inbox-table.md). It deletes only rows that are published and older than the [outbox retention period](bounded-retention.md). It deletes them a limited number of rows at a time, not all at once. [Pending and parked rows](parked-row.md) are never touched. [Terminal inbox rows](inbox-table.md) have their own separate purge job.

## Example
Assume the configured 7-day retention. A row published 8 days ago is deleted. A row that is still pending after 10 days stays, and so does a parked row of any age. Each delete covers at most 1,000 rows.

## Known gaps
- The spec does not say how often the purge job runs or what its schedule name is.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-15
- [bounded-batch](bounded-batch.md)
- [bounded-retention](bounded-retention.md)
- [inbox-table](inbox-table.md)
- [job](job.md)
- [parked-row](parked-row.md)
- [published-row](published-row.md)
<!-- used-by:end -->
