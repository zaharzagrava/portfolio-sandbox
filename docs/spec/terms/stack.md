---
id: stack
title: Stack
kind: term
status: draft
aliases: [one stack]
defined_for: J03-launch-day
rules_hash: ed0ee4949472
---
# Stack
## Definition
The stack is the one running set of services and infrastructure that the [launch-day journey test](launch-day-flow.md) runs against. All concurrent launch-day flows share it, so flow isolation must hold inside it. It includes the test and local [control surface](control-surface.md): [allow-listed jobs](job.md), [consumer pause, resume and lag](consumer-lag.md), and a [read-only event tap](event-tap.md). Design intent (not stated in the spec): a shared stack tests real hand-offs without a separate environment per flow.

## Example
`launch-day.journey-spec.ts` runs a seat booking and a drop on one stack at the same time (illustrative pairing). It pauses the `notification-router` consumer through the control surface, and neither flow alters the other's seats or units.

## Known gaps
- The spec does not say what one stack covers, such as one database, one broker, or one deployed environment.
- Not confirmed in the code: which services make up the stack. Only `infra/docker/elasticmq/elasticmq.conf` is listed, which suggests a local queue configuration.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
