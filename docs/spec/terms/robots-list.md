---
id: robots-list
title: Robots list
kind: term
status: draft
aliases: [robots]
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# Robots list
## Definition
The robots list is the set of [private areas](signed-in-areas.md) that the web app asks [search crawlers ↗](../sw-external-terms.md#web-crawler) not to index. It is built from the same list of private areas as [`noStorePaths`](no-store-paths.md), so the two lists never diverge. Excluding signed-in areas keeps member-only pages out of search results. That reason is design intent (not stated in the spec).

## Example
A private path, such as `/account` (illustrative), is excluded in the robots list. Its response also carries [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store), because `noStorePaths` comes from the same private-areas list.

## Known gaps
- The spec does not say where the robots list is served or which file builds it. No code for it is in the facts.
- The spec states no rule for robots behavior. [AS-34](acceptance-scenario.md) (document metadata, robots) has tests, but the page has no rule for them.
- The spec does not list which paths are on the private-areas list.

## Used by
<!-- used-by:start -->
- [acceptance-scenario](acceptance-scenario.md)
- [signed-in-areas](signed-in-areas.md)
<!-- used-by:end -->
