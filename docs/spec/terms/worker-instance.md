---
id: worker-instance
title: Worker instance
kind: term
status: draft
aliases: [worker]
defined_for: S33-autocomplete
rules_hash: f1a20985a5e7
---
# Worker instance
## Definition
A worker instance is one running process that hosts [`AutocompleteWorkerModule`](autocomplete-worker-module.md), the module that contains the build job. Several worker instances can run at once as replicas. When the schedule fires, only one of them runs [`search.build-autocomplete`](search-build-autocomplete.md), because the job holds a [job lease](job-lease.md) through the [S49 distributed job scheduler](../capabilities/S49-job-scheduler.md). Worker instances are separate from the [serving nodes](serving-node.md), which host `AutocompleteModule` and answer `GET /suggest`.

## Example
Two worker instances are running. The hourly schedule fires, one instance claims the job and builds the snapshot, and the other does nothing for that run.

## Known gaps
- The spec does not say what happens if a build runs longer than its job lease (10 minutes) and a second instance claims the job. Version checks (`superseded`) would still keep the pointer correct.
- Not confirmed in the code: whether worker and serving modules can run in the same process.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-30
- [S28](../capabilities/S28-notifications.md): R-44
- [S33](../capabilities/S33-autocomplete.md): B-17
- [S34](../capabilities/S34-recommendations.md): B-19
- [S49](../capabilities/S49-job-scheduler.md): R-08, B-03, B-17
- [S51](../capabilities/S51-realtime-push.md): B-10, B-11
- [autocomplete-build-total](autocomplete-build-total.md)
- [blocklist-reload](blocklist-reload.md)
- [entry-point](entry-point.md)
- [fleet-concurrency](fleet-concurrency.md)
- [job-lease](job-lease.md)
- [job-run-at](job-run-at.md)
- [ledger-worker-module](ledger-worker-module.md)
- [partition-owner](partition-owner.md)
- [realtime-listener](realtime-listener.md)
- [serving-node](serving-node.md)
- [structured-logs](structured-logs.md)
- [upsert-schedule](upsert-schedule.md)
<!-- used-by:end -->
