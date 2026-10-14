# Event contract: S21 — Limited-Drop Auctions

Outbox rows through `OutboxService.append` inside the transition's transaction (IX.6), topic `auctions.events` (registered by `EventsModule.forAggregates([{ aggregateType: 'auctions', retention: 'full-history' }])`, already present), key `auctionId`. `defineEvent` classes in `application/events/auction-events.ts`; payload schemas in `packages/contracts/src/auctions/auction-events.ts` (`auctionEventSchemas`, keyed by `type`). Envelope: `{ eventId, type, version: 1, occurredAt, aggregateId: auctionId }`. Every payload also carries `auctionId`, `shopId`, `productId` and `auctionVersion` (the auction `version` after the change; strictly increasing per auction in application order). Money is `…Minor` with `currency`. No payload ever carries a maximum or the reserve amount.

| Type | Emitted when | Payload (besides the common fields) |
|---|---|---|
| `auction.created` | create | `{ startsAt, endsAt, currency }` |
| `auction.opened` | `SCHEDULED → OPEN` (job or first bid) | `{ endsAt }` |
| `auction.bid_placed` | every accepted bid | `{ bidderId, outcome: 'leading'\|'outbid'\|'raised', priceMinor, currency, leaderId, endsAt, extended: boolean, sequence }` |
| `auction.leader_changed` | leader actually changed (never for the first bid, never for `raised` or a defended bid) | `{ previousLeaderId, leaderId, priceMinor, currency }` |
| `auction.closed` | `OPEN → CLOSED \| UNSOLD` | `{ status: 'CLOSED'\|'UNSOLD', winnerId \| null, finalPriceMinor \| null, currency, reserveMet, reason: 'winner'\|'no_bids'\|'reserve_not_met'\|'leader_ineligible' }` |
| `auction.second_chance_offered` | `CLOSED → SECOND_CHANCE` | `{ offeredToId, priceMinor, currency, expiresAt }` |
| `auction.sold` | `CLOSED\|SECOND_CHANCE → SOLD` | `{ buyerId, finalPriceMinor, currency, orderId, viaSecondChance }` |
| `auction.unsold` | `CLOSED\|SECOND_CHANCE → UNSOLD` | `{ reason: 'winner_unpaid'\|'second_chance_unpaid' }` |
| `auction.cancelled` | `SCHEDULED\|OPEN → CANCELLED` | `{ reason: 'seller_cancelled'\|'stock_hold_failed' }` |

Notes:
- `bidderId`, `leaderId`, `winnerId`, `buyerId`, `previousLeaderId`, `offeredToId` are user IDs: the topic is an internal one (consumers S28, community, S40, J03); the public views and realtime messages never show them (FR-034).
- Rename against today's producer: `auction.leader_changed.price → priceMinor`; `auction.closed` gains `status`, `currency`, `reason`, `reserveMet` and loses nothing S28 reads. S28's `consumed-events.ts` already parses these field names (`priceMinor`, `finalPriceMinor`, `currency`, `auctionVersion`, `auctionId`), so its switch to the S21 schemas is an import change (follow-up in `gaps.md`).
- A refused outbox append aborts the transaction (AS-23): no bid row, no state change.
- Consumed (S10, `orders.events`, key `orderId`): `order.paid`, `order.cancelled` with the fields in the spec "Requires"; parsed with S10's schemas from `packages/contracts/src/orders`, never copied.
- Realtime (S51), not events: `price` `{ auctionId, priceMinor, leaderAlias, endsAt, reserveMet, version, serverTime }` and `closed` `{ auctionId, status, finalPriceMinor, version }` on topic `auction:<auctionId>`, published after commit via `TransactionRunner` after-commit callbacks, failures counted in `auction_realtime_failed_total`, never thrown.
