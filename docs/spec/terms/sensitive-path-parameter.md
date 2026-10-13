---
id: sensitive-path-parameter
title: Sensitive path parameter
kind: term
status: draft
aliases: [route template]
defined_for: S54-platform-toolkit
rules_hash: 66d9004c635b
---
# Sensitive path parameter
## Definition
A sensitive path parameter is a URL path segment whose value must not be exposed, such as a secret token placed in the path. On routes that have one, the error response's reference to the failing request and the log lines show the route template, not the real path. This keeps the secret value out of error responses and logs. Design intent (not stated in the spec): URLs get copied into tickets, dashboards and log stores, so a secret in a path would leak there.

## Example
A route with the template `/<resource>/:token` (illustrative) fails. Its error body contains `"instance": "/<resource>/:token"`, not the real token value.

## Known gaps
- The spec does not say how a route declares a parameter as sensitive, or which existing routes do.
- The spec does not say whether query strings on these routes are also hidden.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-08
- [problem-instance](problem-instance.md)
<!-- used-by:end -->
