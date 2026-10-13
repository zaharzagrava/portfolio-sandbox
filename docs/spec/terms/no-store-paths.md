---
id: no-store-paths
title: noStorePaths
kind: term
status: draft
aliases: [no-store list]
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# noStorePaths
## Definition
`noStorePaths` is the list of paths whose responses carry [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store). It covers the [signed-in areas](signed-in-areas.md), so no browser or [shared cache ↗](../sw-external-terms.md#shared-cache) keeps a copy of a member's private page. It lives in the [security headers module](security-headers-module.md), next to the [static security headers](static-security-headers.md). It is built from the same list of private areas as the robots list, so the two lists never diverge.

## Example
A request for a private path, such as `/account` (illustrative), gets this response header:
```
Cache-Control: no-store
```
The robots list also excludes the same path, because both lists come from the one private-areas list.

## Known gaps
- The spec does not list which paths are on the private-areas list.
- The spec does not say whether paths match by exact value or by prefix.
- The spec does not say whether `/checkout/pay/*` is on the list.

## Used by
<!-- used-by:start -->
- [security-headers-module](security-headers-module.md)
- [signed-in-areas](signed-in-areas.md)
- [static-security-headers](static-security-headers.md)
<!-- used-by:end -->
