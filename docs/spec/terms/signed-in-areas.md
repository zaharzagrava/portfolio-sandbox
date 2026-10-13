---
id: signed-in-areas
title: Signed-in areas
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: 101d1dff0580
---
# Signed-in areas
## Definition
Signed-in areas are the private parts of the web app that show data belonging to one member. Their responses must carry [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store), so no browser or [shared cache ↗](../sw-external-terms.md#shared-cache) keeps a copy. The no-store list ([`noStorePaths`](no-store-paths.md)) and the list of paths that search engines are told not to crawl both come from one list of private areas, so they never diverge.

## Example
A response for a path on the private-areas list, such as `/account` (illustrative), carries `Cache-Control: no-store`. The robots list also excludes that path.

## Known gaps
- The spec does not list which paths count as signed-in areas.
- The spec does not say whether [`/checkout/pay/*`](checkout-pay-route.md) is on the private-areas list.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-19
- [checkout-pay-route](checkout-pay-route.md)
- [no-store-paths](no-store-paths.md)
- [robots-list](robots-list.md)
- [security-headers-module](security-headers-module.md)
<!-- used-by:end -->
