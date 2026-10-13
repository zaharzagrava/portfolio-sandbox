---
id: validated-config-module
title: Validated config module
kind: term
status: draft
aliases: [config module]
defined_for: W07-app-shell
rules_hash: 0f8a1aee59df
---
# Validated config module
## Definition
The validated config module is the one place where the web app reads its environment settings (`packages/web/lib/config.ts`, export `config`). Code elsewhere in the app takes settings from this module and does not read the environment directly. The settings it covers include the service URLs, the media and map hosts, the [payment provider hosts](payment-provider-hosts.md), the allowed origins and the source code link. Design intent (not stated in the spec): with one module, every setting is checked in a single place, and each part of the app sees the same value.

## Example
These are the settings the module reads:
`SITE_URL`, `API_URL`, `BFF_URL`, `SSE_URL`, [`MEDIA_HOST`](media-host-setting.md), `VIDEO_HOST`, [`MAP_TILE_HOST`](map-tile-host-setting.md), `PAYMENT_PROVIDER_HOSTS`, `WIDGET_APP_BUNDLE_URL`, [`SOURCE_CODE_URL`](source-code-url.md), `ALLOWED_ORIGINS`.
For example, [`buildCsp`](build-csp.md) gets the payment provider hosts from here and adds them to the policy only on [`/checkout/pay/*`](checkout-pay-route.md).

## Known gaps
- The spec does not say what the validation checks, for example the URL format, required settings or the ban on wildcards.
- The spec does not say what happens when a setting is missing or invalid: whether the build fails, startup fails, or a request fails.
- The spec does not say whether a setting has a default value when it is not set.

## Used by
<!-- used-by:start -->
- [backend-api](backend-api.md)
- [map-tile-host-setting](map-tile-host-setting.md)
- [map-tile-hosts](map-tile-hosts.md)
- [media-host-setting](media-host-setting.md)
- [payment-provider-hosts](payment-provider-hosts.md)
- [platform-fee](platform-fee.md)
- [source-code-url](source-code-url.md)
- [video-host-setting](video-host-setting.md)
<!-- used-by:end -->
