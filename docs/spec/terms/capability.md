---
id: capability
title: Capability
kind: term
status: draft
aliases: [capability page, capability's specification]
defined_for: S05-products
rules_hash: 33b4a8d3bb80
---
# Capability
## Definition
A capability is one numbered part of the system specification that covers one area of the product, such as products or rate limiting. Its page names the capability by id and lists its purpose, entry points, rules, behaviors, [lifecycles](product-lifecycle.md), what it owns, decisions and the problems it does not yet handle. Other capabilities may use what it owns only through its [exported commands and events](catalog-stock-command.md). Pages refer to other capabilities with ids such as `{{cap:S03}}`.

## Example
`S05` is the product capability. It owns the `Product` table and the [`products.events` topic](products-events-topic.md). It exports [`ProductStockService.applyStockDelta`](apply-stock-delta.md), so another domain changes stock by calling that command. It never writes the `Product` table directly.

## Known gaps
- The spec does not say whether a capability always maps to one code module. For example, S05's code sits under `packages/backend/libs/domains/catalog`, a domain whose name is different from the capability's name.
- The spec does not say how capability ids are assigned, or whether a capability can be split or retired.

## Used by
<!-- used-by:start -->
- [W01](../capabilities/W01-auth-account.md): R-20
- [acceptance-scenario](acceptance-scenario.md)
- [behavior](behavior.md)
- [catalog-stock-command](catalog-stock-command.md)
- [code-facts](code-facts.md)
- [decisions](decisions.md)
- [default-rate-limit-policies](default-rate-limit-policies.md)
- [entry-point](entry-point.md)
- [known-gaps](known-gaps.md)
- [media-host-setting](media-host-setting.md)
- [membership-query-service](membership-query-service.md)
- [payment-succeeded-event](payment-succeeded-event.md)
- [post-bff-session-logout](post-bff-session-logout.md)
- [product-lifecycle](product-lifecycle.md)
- [products-events-topic](products-events-topic.md)
- [server-rendered-search](server-rendered-search.md)
- [shop-cell](shop-cell.md)
- [shop-provisioning-service](shop-provisioning-service.md)
- [shop-query-service](shop-query-service.md)
- [shop-sso-config](shop-sso-config.md)
- [sso-controller](sso-controller.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
- [trending-configuration](trending-configuration.md)
- [video-host-setting](video-host-setting.md)
<!-- used-by:end -->
