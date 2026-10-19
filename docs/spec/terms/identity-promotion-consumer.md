---
id: identity-promotion-consumer
title: Identity promotion consumer
kind: term
status: draft
aliases: []
defined_for: J02-seller-to-first-sale
rules_hash: e3b0c44298fc
---
# Identity promotion consumer
## Definition
The identity promotion consumer is the [event consumer](event-consumer.md) in the [identity domain](identity-domain.md) that turns a `USER` into a [`SELLER`](shop-role.md). It listens for the [`tenancy.shop_created`](shop-created-event.md) event and promotes the shop's owner. This is the only path to the `SELLER` role, because only identity writes `User` and tenancy must never write the role. The promotion is conditional and [idempotent ↗](../sw-external-terms.md#idempotency), so a replayed or duplicate event changes nothing. If the consumer is paused, the role stays `USER` and its [consumer lag](consumer-lag.md) grows, but the owner can still use the new shop.

## Example
In AS-02 a new user creates a shop, and tenancy appends `tenancy.shop_created`. Once the consumer applies it, `GET /auth/me` shows the role `SELLER`, and the next refreshed access token carries `SELLER`.
In AS-05 the consumer is paused, so the role stays `USER` and its lag shows at least 1 until it resumes.

## Known gaps
- The spec does not say what condition the promotion checks. "Conditionally" may mean "only if the role is still `USER`", but this is not confirmed.
- The spec does not say whether anything demotes a `SELLER` back to `USER`, for example after the last shop is deleted or offboarded.
- Not confirmed in the code: the facts name no class, file or consumer group for this consumer.

## Used by
<!-- used-by:start -->
- [consumer-lag](consumer-lag.md)
<!-- used-by:end -->
