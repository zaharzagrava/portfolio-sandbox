---
id: map-tile-host-setting
title: MAP_TILE_HOST
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# MAP_TILE_HOST
## Definition
`MAP_TILE_HOST` is a web app setting that names the server the app loads map tiles from. The web app reads it through the [validated config module](validated-config-module.md), together with the other settings that [W07](../capabilities/W07-app-shell.md) owns. The [Content Security Policy ↗](../sw-external-terms.md#content-security-policy) uses this host to let the browser load map tiles. [Map tile hosts in the policy](map-tile-hosts.md) must never be [wildcards ↗](../sw-external-terms.md#csp-host-source-wildcard). They must be exact host names.

## Example
With `MAP_TILE_HOST=tiles.maps.example` (illustrative value), the policy that `buildCsp` builds allows `tiles.maps.example`. It must never allow a pattern such as `*.maps.example`.

## Known gaps
- The spec does not say whether `MAP_TILE_HOST` holds one host or a list. The name is singular, but rule W07.R-17 talks about "map tile hosts".
- Not confirmed in the code: that `buildCsp` reads `MAP_TILE_HOST`. The facts only show that the config module reads the setting and that `buildCsp` enforces the rule against wildcards.
- The spec does not say whether a wildcard value in `MAP_TILE_HOST` is rejected when the config is read, or is only kept out when the policy is built.

## Used by
<!-- used-by:start -->
- [map-tile-hosts](map-tile-hosts.md)
- [validated-config-module](validated-config-module.md)
<!-- used-by:end -->
