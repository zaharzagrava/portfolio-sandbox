# Retired scenarios of S21

`packages/backend/libs/domains/auctions/auctions.e2e-spec.ts` (6 tests; it called service classes, the relay and `BisOrderModel` directly) was rewritten as a smoke spec with S21 ids on the new design (the gate refuses to delete an id-less test file whose subject is not deleted; L-017). It had no `AS-nn` ids, so no id is retired; each behavior is carried by:

- proxy bidding: the visible price is second-highest max + increment, capped by the leader max → `auction-bidding.e2e-spec.ts` `S21 AS-11`, `AS-12` and `proxy-bid.spec.ts` `S21 AS-53`
- 50 concurrent bids: the highest max wins at second max + increment, state never regresses → `S21 AS-19` (50 repeated runs)
- anti-sniping: a bid in the final 2 minutes extends the end → `auction-anti-sniping.e2e-spec.ts` `S21 AS-24`, `AS-25`
- the selling shop's members cannot bid → `auction-shill-guard.e2e-spec.ts` `S21 AS-40`
- bid relay: stream → Postgres in batches, idempotent on redelivery → **no replacement by design**: the relay is deleted; the property it guarded (no lost or doubled bid) is `S21 AS-18`, `AS-19`, `AS-22`
- close exactly once, winner gets a RESERVED order, an extended auction is re-scheduled instead of closed → `auction-close.e2e-spec.ts` `S21 AS-27`, `AS-28`, `AS-33` and `auction-anti-sniping.e2e-spec.ts` `S21 AS-26`

## Confirmed carried (T059, L-017)

`auctions.e2e-spec.ts` is rewritten (see above). Every behavior above is carried by a test that exists and passes:

| Retired behavior | Carried by (file → test title prefix) |
|---|---|
| proxy bidding table | `auction-bidding.e2e-spec.ts` → `S21 AS-11: the four-step table …`, `S21 AS-12: a tie goes to the earlier bidder …`; `domain/proxy-bid.spec.ts` → `S21 AS-53 …` |
| 50 concurrent bids | `auction-bidding.e2e-spec.ts` → `S21 AS-19: 50 bidders at once, 50 times …`, `S21 AS-20: equal maximums at once …` |
| anti-sniping | `auction-anti-sniping.e2e-spec.ts` → `S21 AS-24 …`, `S21 AS-25: the end stops at the original end + 60 min exactly …` |
| selling shop's members cannot bid | `auction-shill-guard.e2e-spec.ts` → `S21 AS-40: every role of the selling shop is refused …` |
| bid relay (stream → Postgres, idempotent redelivery) | no replacement by design; the property is `auction-bidding.e2e-spec.ts` → `S21 AS-18 …`, `S21 AS-19 …`, `S21 AS-22: after a full flush of the fast store …` |
| close exactly once, winner RESERVED order | `auction-close.e2e-spec.ts` → `S21 AS-27: CLOSED with the winner …`, `S21 AS-28: three deliveries at once …`, `S21 AS-33 …` |
| an extended auction is re-scheduled instead of closed | `auction-anti-sniping.e2e-spec.ts` → `S21 AS-26: the original job at E leaves it OPEN …` |
