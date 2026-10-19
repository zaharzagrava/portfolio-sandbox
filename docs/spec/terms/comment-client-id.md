---
id: comment-client-id
title: clientId (comment)
kind: term
status: draft
aliases: [clientid]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# clientId (comment)
## Definition
`clientId` is a key the client sends with a [live-stream comment](comment-moderation.md) so that a [retried post is safe ↗](../sw-external-terms.md#idempotency). If the same `clientId` arrives again with the same text, the system keeps one comment. If the same `clientId` arrives with different text, the post is refused with [`client_id_reused`](client-id-reused.md). This follows the [journey decision](main-journeys.md) that every creating request carries a key, so retries are safe.

## Example
A viewer posts "Love this colour!" with `clientId` `c-123` (illustrative). The network drops, so the app retries with the same `clientId` and text, and only one comment exists. A post of "Too pricey" with `c-123` answers `422 client_id_reused` (J03.R-18).

## Known gaps
- The spec does not say the format of a `clientId`, or its scope (per viewer, per stream, or global).
- The spec does not say how long a `clientId` is remembered.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
