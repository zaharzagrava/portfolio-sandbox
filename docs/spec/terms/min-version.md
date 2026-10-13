---
id: min-version
title: minVersion
kind: term
status: draft
aliases: []
defined_for: problem-json-errors
rules_hash: 93eec916b8a9
---
# minVersion
## Definition
`minVersion` is a request input read by [S53](../capabilities/S53-events-projections.md). S53 rejects an invalid value at once with a [`400` problem+json error ↗](../sw-external-terms.md#problem-json), and does not wait first. Because of that rule, a valid `minVersion` probably makes S53 wait until its data has caught up to that version. That reading ties it to [read-your-writes](read-your-writes.md), but it is design intent (not stated in the spec).

## Example
A client sends `minVersion=abc` (or `-1`, or `1.5`) to S53. It gets a `400` `application/problem+json` response straight away, with a [`requestId`](request-id.md), and no waiting happens.

## Known gaps
- The spec does not say which values are valid. The rejected examples only suggest it must be a whole number that is not negative.
- The spec does not say what a valid `minVersion` does: how long S53 waits, or what it returns if the version is never reached.
- The spec does not say which [`code`](error-code.md) the `400` carries. It may be [`validation_failed`](validation-failed-error.md), but that is not confirmed.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-18
- [S52](../capabilities/S52-cache-toolkit.md): R-19, B-14
- [read-your-writes](read-your-writes.md)
<!-- used-by:end -->
