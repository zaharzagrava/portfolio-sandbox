# Data Model: S22

## Postgres (expand-only migrations; tables owned by `launch-events`)

- **LaunchEvent** (existing): `id`, `shopId UUID NOT NULL` (FK to `Shop` dropped, G-37), `title`, `venue`, `startsAt`, `salesOpenAt`, `seatCount` (1–100000), `seatsPerRow`, `seatingMode` (`SEATED|GENERAL`, default `SEATED`), `perUserLimit` (1–10, default 2), `admissionRatePerSec`, `humanCheckRequired` (default false), `status` (`SCHEDULED|ON_SALE|SOLD_OUT|CLOSED`), `closedReason` (`organizer|started`, nullable). Allowed transitions: `SCHEDULED→ON_SALE`, `ON_SALE→SOLD_OUT`, `SCHEDULED|ON_SALE|SOLD_OUT→CLOSED`; each is `UPDATE … WHERE status = :from` asserting one row (`domain/event-state.ts`).
- **LaunchEventHistory** (new): `id`, `launchEventId`, `fromStatus`, `toStatus`, `reason`, `at`; index (`launchEventId`, `at`).
- **Booking** (existing): one row per seat; `status` `CONFIRMED` (`CANCELLED` reserved, unreachable); `holdId`, `userId`, `seat`, `confirmedAt`. Keeps partial unique index `Booking_one_confirmed_per_seat` (event, seat) WHERE CONFIRMED. Add indexes (`eventId`, `confirmedAt DESC`, `id DESC`) for keyset paging and (`eventId`, `userId`).
- **BookingEvent** (new history): `id`, `bookingId`, `fromStatus` (nullable), `toStatus`, `holdId`, `at`.

## DynamoDB hold ledger

- Hold item: `{holdId, eventId, userId, seats[], state, expiresAtMs, createdAtMs, confirmedAtMs?}`.
- Seat item: `{eventId, seat, holdId, fence, expiresAtMs, state}`.
- Hold states (`domain/hold-state.ts`): `HELD→CONFIRMING→CONFIRMED`, `HELD→RELEASED`, `HELD→EXPIRED`. Every other pair is rejected with `HOLD_EXPIRED`, `HOLD_RELEASED` or `HOLD_ALREADY_CONFIRMED`. Hold records are kept after release (not deleted).

## Redis (all keys expire; all rebuildable except live tickets)

Queue shards `lq:{event}:0..7` (sorted sets), ticket hash `lt:{event}:<ticket>` (owner, score, lastSeen, admitted, token expiry), user→ticket `lu:{event}:<user>`, admitter epoch, seat map bitmap `sm:{event}` with `sm:{event}:seq`, quota `quota:{event}:<user>`, seat lock filter, status gate `gate:{event}`, one-time human-check results.

## Value objects

Queue ticket (Redis only): `{ticket, eventId, userId, score, lastSeenMs, admitted, tokenExpiresAtMs}`. Admission token claims per FR-006 (`iss marketplace`, `aud admission:<eventId>`, `sub` buyer, `jti` ticket, purpose `admission`, 600 s).
