# Contract: S26 events

## Provided

`feed.item_published` v1 on topic `feed.events` (new `FEED_AGGREGATE` registration, key = `authorId`, aggregate type `feed_item`, aggregate id = `itemId`). Envelope per constitution IV.4 (`eventId`, `type`, `version: 1`, `occurredAt`, `aggregateId`). `eventId` is derived from `itemId` so a repeated announcement carries the same id.

```ts
{ itemId: string /* timeuuid */, authorId: string /* 'shop:<uuid>' | 'user:<uuid>' */,
  kind: 'new_product' | 'price_drop' | 'post' | 'drop_announced' | 'auction_started',
  createdAt: string /* ISO */ }
```

Zod schema and `defineEvent` in `packages/contracts/src/community/events.ts` (next to S25's). Consumers: this capability's fan-out; S28 may consume it for "new from a shop you follow" (not required). Delivery: at least once from `pending_announcements` (research R-5). No follow events are published.

## Consumed

| Topic / key | Event (version) | Fields used | Effect |
|---|---|---|---|
| `products.events` / `productId` (compacted) | `catalog.product_created|updated|archived|restored` v1 | `productId, shopId, title, priceMinor, currency, status, isSandbox, productVersion, changedFields` (aggregateVersion = `productVersion`) | product copy upsert (version guard); `new_product` / `price_drop` items |
| `products.events` | `catalog.product_deleted` v1 | `productId, shopId, productVersion` | copy state `DELETED` |
| `products.events` | `catalog.product_changed` (transitional) | – | ignored (not handled) |
| `discussion.events` / `postId` | `discussion.post_created` v1 `{postId, boardId, authorId, title, createdAt}` | all | `post` item unless tombstoned |
| `discussion.events` | `discussion.post_deleted` v1 `{postId, boardId, deletedBy}` | `postId` | tombstone (TTL 30 d) |
| `auctions.events` / `auctionId` | `auction.created` v1 `{startsAt, endsAt, auctionVersion, shopId, productId}` | all | `drop_announced` item |
| `auctions.events` | `auction.opened` v1 `{endsAt, auctionVersion, shopId, productId}` | all | `auction_started` item |
| `feed.events` / `authorId` | `feed.item_published` v1 | all | fan-out |

Every consumer validates the payload with its schema (framework `handles`), dead-letters an invalid one with the reason and no side effect, and is idempotent (version guard for products, claims for items, `fanout_done` for fan-out). Consumer group ids: `feed-products`, `feed-posts`, `feed-auctions`, `feed-fanout`.

## Jobs (S49)

`feed.relay-announcements` (every 5 s), `feed.relay-sweep` (hourly), `feed.reconcile` (daily cron, state `{phase: 'accounts' | 'relations', pageState: string | null}`), each declared with `declareJobType` and a zod payload contract next to the `JobPayloads` augmentation in `infra/feed.jobs.ts`; schedule registration catches `InvalidScheduleError`.
