---
id: map-tile-hosts
title: Map tile hosts (CSP)
kind: term
status: draft
aliases: [map tile hosts]
defined_for: W07-app-shell
rules_hash: 53658101e3c7
---
# Map tile hosts (CSP)
## Definition
Map tile hosts are the servers that supply map images to the web app. The [Content Security Policy ↗](../sw-external-terms.md#content-security-policy) must allow them, or the browser blocks the maps. The host comes from the [`MAP_TILE_HOST`](map-tile-host-setting.md) setting, which the [validated config module](validated-config-module.md) reads. [`buildCsp`](build-csp.md) must list each map tile host by its exact name, never as a [wildcard ↗](../sw-external-terms.md#csp-host-source-wildcard) pattern. Design intent (not stated in the spec): a wildcard would also allow every other host under that domain, which makes the policy much weaker.

## Example
With `MAP_TILE_HOST=tiles.maps.example` (illustrative), the policy built by `buildCsp` names `tiles.maps.example`. It must not contain `*.maps.example`.

## Known gaps
- The spec does not say which [CSP directive ↗](../sw-external-terms.md#csp-directive) holds the map tile host, for example whether it goes in the image rule or the connection rule.
- The spec does not say whether the map tile host is in the policy on every route or only on pages that show a map.
- The spec does not say how `MAP_TILE_HOST` is checked for wildcards at startup, or whether it is checked at all.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-17
- [build-csp](build-csp.md)
- [map-tile-host-setting](map-tile-host-setting.md)
- [validated-config-module](validated-config-module.md)
<!-- used-by:end -->
