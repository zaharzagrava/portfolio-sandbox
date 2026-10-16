# HTTP contracts (S22)

All under `/api`; errors are problem+json with `code` and `requestId`. Schemas live in `packages/contracts/src/launch-events/`. The authoritative list is `spec.md` "Provides"; error codes are FR-051.

| Route | Auth | Success | Schema |
|---|---|---|---|
| `POST /shops/:shopId/launch-events` | `ShopScoped('products.write')` | 201 + `Location` | `createLaunchEventRequestSchema` → `launchEventSchema` |
| `POST /shops/:shopId/launch-events/:eventId/close` | `products.write` | 200 | `launchEventSchema` |
| `GET /shops/:shopId/launch-events/:eventId/bookings?limit&cursor` | `orders.manage` | 200 | `bookingPageSchema` |
| `GET /launch-events/:eventId` | anonymous, `s-maxage=60` | 200 | `launchEventSchema` (public fields) |
| `POST /launch-events/:eventId/queue` | session, optional `X-Human-Check`, `launch.queue.join.user` | 201 new, 200 existing | `queueStatusSchema` |
| `GET /launch-events/:eventId/queue/:ticket` | session, owner | 200 | `queueStatusSchema` |
| `POST /launch-events/:eventId/holds` | session, `X-Admission-Token`, `Idempotency-Key`, `launch.hold.user` | 201 | `holdSeatsRequestSchema` → `holdSchema` |
| `POST /launch-holds/:holdId/confirm` | session, `Idempotency-Key` | 201 first, 200 repeat | `confirmResponseSchema` |
| `DELETE /launch-holds/:holdId` | session | 204 | none |
| `GET /launch-events/:eventId/seatmap` | anonymous, `s-maxage=1`, `launch.seatmap.ip` | 200 | `seatMapSchema` |
| `GET /launch-events/:eventId/my-bookings` | session | 200 | `{items:[{bookingId, seat, confirmedAt}]}` |

Hold check order (G-13): auth → body → admission token (zero store access) → event status → seats → quota → ledger. 503 answers carry `Retry-After` (`WAITING_ROOM_FULL` 5 s, `HOLDS_UNAVAILABLE` 2 s).
