---
id: identical-not-found
title: Identical 404 (no existence leak)
kind: term
status: draft
aliases: [identical 404]
defined_for: S03-shops-rbac
rules_hash: 15a498afb1ac
---
# Identical 404 (no existence leak)
## Definition
Several different failures return exactly the same `404` answer, so a caller can't learn whether something exists. For shops, a [non-member](shop-membership.md), an unknown shop, a malformed id and a deleted shop all get [`shop_not_found`](shop-not-found.md). For invites, every failed [accept](invite-acceptance.md) gets [`invite_not_found`](invite-not-found.md). When someone who isn't signed in looks up a shop's single sign-on settings by its public name, any miss gets the same `404`. The spec states the reason: callers cannot probe which shops exist.

## Example
A user who is not a member calls `GET /shops/shop_123` (id illustrative). They get the same `404 shop_not_found` body as for `GET /shops/does-not-exist`. Nothing in the answer shows that `shop_123` is real.

## Known gaps
- The spec does not say whether response timing is also equalised, so a timing difference could still reveal that a shop exists.
- The spec does not say which cases make the SSO slug lookup return `404`: an unknown slug, a shop without SSO, or an inactive shop.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-15
- [S13](../capabilities/S13-payment-intents.md): R-04, B-20
- [S34](../capabilities/S34-recommendations.md): R-03
- [S51](../capabilities/S51-realtime-push.md): R-15
- [S53](../capabilities/S53-events-projections.md): B-19
- [W03](../capabilities/W03-cart-checkout-orders.md): R-17
- [default-deny-topic](default-deny-topic.md)
- [invite-acceptance](invite-acceptance.md)
- [linked-identity](linked-identity.md)
- [shop-membership](shop-membership.md)
- [shop-product-search-route](shop-product-search-route.md)
- [shop-sso-lookup](shop-sso-lookup.md)
<!-- used-by:end -->
