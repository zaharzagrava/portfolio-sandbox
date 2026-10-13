---
id: default-deny-topic
title: Default-deny topic
kind: term
status: draft
aliases: [no defined rule, private]
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# Default-deny topic
## Definition
A default-deny topic is a topic type whose owner has not yet defined an [access rule](realtime-topic-access-rule.md) in the [topic registry](topic-registry.md). Such a topic stays private, so the [hub](realtime-hub.md) does not admit viewers to it. A refused connection gets the [normal refusal](connection-admission.md): `401` for an [anonymous viewer](viewer.md) and `403` for an authenticated one (S51.R-14). The `403` is [identical to the answer for a topic that does not exist](identical-not-found.md) (S51.R-15). The spec gives one reason: a new topic type must not be exposed by accident.

## Example
A domain adds a new topic type such as `shop:X:drafts` (illustrative) but defines no rule for it yet. A signed-in client calls `GET /api/streams?topics=shop:X:drafts` and gets `403`, the same answer it would get for a topic that does not exist. An anonymous client gets `401`.

## Known gaps
- The spec does not say what "private" means in practice: whether every viewer is refused, or whether some viewers (the owner, for example) are still admitted.
- The spec does not say whether a request that mixes this topic with allowed topics is refused as a whole. S51.R-14 (all requested topics or none) suggests it is, but no rule or test says so for this case.
- Not confirmed in the code: the facts point to no code that applies the default-deny behaviour, and no test ID is tied to it.

## Used by
<!-- used-by:start -->
- [connection-admission](connection-admission.md)
- [identical-not-found](identical-not-found.md)
- [realtime-hub](realtime-hub.md)
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
- [topic-registry](topic-registry.md)
- [viewer](viewer.md)
<!-- used-by:end -->
