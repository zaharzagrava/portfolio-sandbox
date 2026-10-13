---
id: consumer-declaration-error
title: ConsumerDeclarationError
kind: term
status: draft
aliases: []
defined_for: projection-and-replay
rules_hash: e3b0c44298fc
---
# ConsumerDeclarationError
## Definition
`ConsumerDeclarationError` is the error that stops a service at startup when a [consumer](event-consumer.md) is declared wrongly. It is raised in two cases: a consumer did not declare [`inbox`](inbox-table.md), [`versionGuard`](version-guard.md) or [`natural`](natural-idempotency.md), or two consumers share a [group name](consumer-group.md). Because it happens at startup, a misconfigured consumer never processes a single event. Design intent (not stated in the spec): it fails early so that a consumer can never run without a defined way to avoid double effects.

## Example
Two consumers are registered and both declare the same group name, for example `search-index` (illustrative). Startup fails with `ConsumerDeclarationError`, and neither consumer starts.

## Known gaps
- The spec does not say what the error message or its fields contain, such as which consumer or group caused it.

## Used by
<!-- used-by:start -->
- [consumer-group](consumer-group.md)
- [event-consumer](event-consumer.md)
<!-- used-by:end -->
