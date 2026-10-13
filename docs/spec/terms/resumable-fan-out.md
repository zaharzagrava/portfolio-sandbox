---
id: resumable-fan-out
title: Resumable fan-out
kind: term
status: draft
aliases: [resumable]
defined_for: S28-notifications
rules_hash: 523e541885e9
---
# Resumable fan-out
## Definition
A resumable fan-out is one that can be interrupted at any point and continued by simply running it again. Here the retry walks the whole follower list from the start. Each notification's [dedupe identity](dedupe-identity.md) stops anything from being created a second time. The result after a retry equals one complete, uninterrupted fan-out.

## Example
A fan-out to 10,000 followers (illustrative) crashes after 4,000. The retry walks all 10,000 again. The first 4,000 already have their [inbox items](inbox-item.md) and [deliveries](delivery.md), so only the remaining 6,000 get new ones.

## Known gaps
- The spec does not say whether progress is [checkpointed](checkpoint-lookup.md). As written, every retry re-walks the full list, which may be costly for large audiences.
- No [acceptance scenario](acceptance-scenario.md) backs this rule (S28.R-11 is `[proof: none]`).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-11
- [acceptance-scenario](acceptance-scenario.md)
- [checkpoint-lookup](checkpoint-lookup.md)
- [dedupe-identity](dedupe-identity.md)
- [delivery](delivery.md)
- [follower-fan-out](follower-fan-out.md)
- [inbox-item](inbox-item.md)
<!-- used-by:end -->
