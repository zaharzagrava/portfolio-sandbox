---
id: unsupported-media-type
title: unsupported_media_type (415)
kind: term
status: draft
aliases: [unsupported_media_type]
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# unsupported_media_type (415)
## Definition
`unsupported_media_type` is the error code returned when a request's [`Content-Type` ↗](../sw-external-terms.md#content-type) is a [media type ↗](../sw-external-terms.md#media-type) the route does not accept. [The problem exception filter](problem-exception-filter.md) renders it as a [problem+json ↗](../sw-external-terms.md#problem-json) response. The body is rejected before the handler runs. It is one of the [fixed pipeline errors](error-catalogue.md) that every app gets from the [platform toolkit](platform-toolkit.md).

## Example
A client sends a form-encoded body (`Content-Type: application/x-www-form-urlencoded`, illustrative) to a JSON route and receives `415` with `code: "unsupported_media_type"`.

## Known gaps
- The spec does not say which media types are accepted, or whether that list is global or set per route.

## Used by
<!-- used-by:start -->
- [error-catalogue](error-catalogue.md)
- [platform-toolkit](platform-toolkit.md)
- [problem-exception-filter](problem-exception-filter.md)
<!-- used-by:end -->
