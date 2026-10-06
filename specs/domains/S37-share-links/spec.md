# Feature Specification: S37 — Share and Affiliate Short Links (code generation, custom aliases, redirects, click attribution)

**Feature Branch**: none (spec directory `specs/domains/S37-share-links`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S37 of `scripts/sdd/capabilities.tsv` (domain `marketing`). Sources: `docs/showcase/sections/SD-08-share-links.md` and `10-System-Design/05-social-and-content.md` §8 (URL shortener), read from the Interview-Prep copy at `.specify/memory/Interview-Prep/` (the notes win over the code). Pattern rows: P0320 (ID-range leases) and P1109 (Base62 + Feistel bijection) of `docs/architecture/pattern-map.md`.

## Scope

**In scope** (everything a link owner, a visitor and an attributing consumer can observe of short links):

- Creating a short link to a marketplace page: a generated, unguessable, fixed-length code, or a custom alias; optional expiry; per-owner limit; idempotent creation.
- Destination safety: only marketplace pages are allowed (no open redirect); a reputation check hook on create.
- The public redirect: `302` with the attribution reference appended, short shared-cache lifetime, negative answers for unknown, expired and disabled codes, and behaviour when the store, cache or event pipeline is degraded.
- The edge redirect (the `edge-be` worker): serves hot codes without touching the origin and records the click itself.
- Click recording and attribution: one click event per served redirect, the `ref` reference carried to checkout, and an exported lookup that tells a consumer who owns a reference.
- Managing links: list (cursor pages), change the destination, disable.
- Click statistics for the owner.
- Operations of this capability: configuration checks, metrics, graceful shutdown, ownership of its stores.

**Out of scope** (owned elsewhere; named so nothing is built twice):

- Sponsored listings, ad click tokens and ad billing → **S36** (same domain `marketing`, separate module; S36 does not touch share-link code).
- The storefront's share button, the first-party `ref` cookie (30 days) and the share panel → **W02**. Checkout reading the cookie and attaching it to an order → **S10**. Affiliate **commission** rules and the ledger entry → not specified anywhere yet (see Cross-capability contracts, Requires); this capability only supplies the owner of a reference.
- The shared rate limiter, outbox, consumer framework and dead-letter handling, problem+json, clock, config validation, metrics → **S50**, **S53**, **S54**.
- Share links for files (asset library) → **S31**; unlisted-video links → **S30**. They are different link kinds with their own tokens and origin.
- Shop-owned links, link folders or tags, QR codes, per-link custom domains, A/B destinations, bulk import, restoring a disabled link, changing a link's expiry, geo or device targeting.
- Bot detection and click-fraud filtering (every served redirect is one click; see Assumptions).

**Pattern coverage** (every row of `pattern-map.md` that lists S37 must appear as requirements and scenarios):

| Pattern | Requirements | Scenarios |
|---|---|---|
| P0320 IDs: ID-range leases | FR-003 – FR-007 | AS-05, AS-06, AS-07, AS-08 |
| P1109 Base62 + Feistel bijection | FR-001 – FR-002, FR-004 | AS-05, AS-07 |

## User Scenarios & Testing *(mandatory)*

**Notation.** `F` is the configured storefront origin (`https://shop.example`); `B` is the configured short-link base (`https://mkt.to`). Users: `U1` (owner), `U2` (another signed-in user), `ANON` (no credentials). `T` is the frozen clock. A link has a **code** (generated: 7 characters of `0-9A-Za-z`; custom: an alias), a **destination**, a **status** (`ACTIVE` or `DISABLED`) and an optional **expiry**; "expired" is derived from the clock, never stored as a status. The public redirect path is `/api/l/<code>` at the origin and `/l/<code>` at the edge. All errors are `application/problem+json` carrying `type`, `title`, `status`, `detail`, `instance` and `requestId`; the machine-readable error code is in `type` (shown below as `code`).

### User Story 1 — A signed-in user turns a marketplace page into a short link (Priority: P1)

A buyer, influencer or shop member pastes a product or drop URL and gets a short link such as `B/aB3x9Kq` to post on social media. The code is unguessable, creation is safe to retry, and the link can only ever point at the marketplace itself.

**Why this priority**: no links, no shares, no attribution.

**Independent Test**: call `POST /api/links` as each user; assert the response, the stored link and, for retries, that exactly one link exists.

**Acceptance Scenarios**:

1. **AS-01** (create, happy path) — **Given** `U1`, **When** `POST /api/links {destination: "F/p/iphone-17?color=blue"}` with `Idempotency-Key: K1`, **Then** `201` with `Location: /api/links/<code>`; the body parses with `shortLinkSchema`: `{code (7 chars of 0-9A-Za-z), shortUrl: "B/<code>", destination: "F/p/iphone-17?color=blue", status: "ACTIVE", createdAt: T, updatedAt: T, expiresAt: null, kind: "generated"}`; the body has no owner ID and no internal field; exactly one link is stored for `U1`; a `link_created` metric with `kind=generated` is incremented.
2. **AS-02** (validation classes) — **Given** `U1`, **When** the body is each of: no `destination`; `destination` not a string; not a URL; a relative path; longer than 2,048 characters; containing a space, a control character or a newline; `ttlDays` of `0`, `-1`, `3651`, `1.5` or `"7"`; `alias` not a string; an unknown property (`ownerId`, `status`, `code`); the `Idempotency-Key` header missing, shorter than 8 or longer than 128 characters, **Then** each answers `400 validation_failed` naming the offending field and nothing is stored.
3. **AS-03** (destination policy, no open redirect) — **Given** `F` = `https://shop.example`, **When** the destination is each of: `http://shop.example/p/x` (not https); `javascript:alert(1)`; `data:text/html,x`; `ftp://shop.example/x`; `https://evil.example/phish`; `https://shop.example.evil.com/x`; `https://evilshop.example/x`; `https://sub.shop.example/x`; `https://shop.example@evil.example/x`; `https://shop.example\@evil.example/x`; `https://shop.example:8443/x`; `https://shop.example./x`; a punycode lookalike of the host, **Then** each answers `422 destination_not_allowed` and nothing is stored; **When** the destination is `https://SHOP.example/p/x?a=1#reviews`, `https://www.shop.example/p/x`, **Then** `201` and the stored destination has the host in lower case.
4. **AS-04** (reference parameter stripped) — **Given** `U1`, **When** creating with `F/p/x?a=1&ref=EVIL&b=2#top`, **Then** `201` and the stored destination is `F/p/x?a=1&b=2#top` (the `ref` parameter is removed; other parameters, their order and the fragment are kept).
5. **AS-05** (code properties) — **Given** a fixed secret key, **When** the numbers `1 … 10,000` are turned into codes, **Then** every code has exactly 7 characters of `0-9A-Za-z`, all 10,000 are different, the mapping is reversible (the original number is recovered from the code), consecutive numbers give codes whose numeric values differ by more than 1,000, the same number under another key gives another code, the largest number of the code space still gives 7 characters, and a number outside the code space is refused. **When** 1,000 links are created concurrently by `U1` through 3 application instances, **Then** 1,000 different codes exist and none equals another link's code.
6. **AS-06** (ID leases) — **Given** instances that each take a block of 1,000 numbers from a shared counter with one call per block, **When** an instance hands out 2,500 numbers, **Then** exactly 3 counter calls were made; **When** an instance stops with part of its block unused and another starts, **Then** the unused numbers are never handed out again, no number is handed out twice, and no gaps are ever visible to users (codes stay unguessable). **When** 5 concurrent creates arrive at an instance whose block is exhausted, **Then** only one counter call is made and all 5 get different numbers.
7. **AS-07** (generated code collides) — **Given** a stored link whose code equals the code the next number would produce (a custom alias, a changed secret key, or a counter that went backwards), **When** `U1` creates a link, **Then** `201` with a different code, the existing link is untouched, and `link_code_collision_total` is incremented; **Given** every attempt collides (5 in a row), **Then** `503 code_generation_failed` and nothing is written.
8. **AS-08** (dependency failure on create) — **Given** each of the counter, the existence filter and the link store being unavailable (forced), **When** `U1` creates a link, **Then** `503 service_unavailable` with a generic `detail`, no link is stored, and no existence-filter entry points at a missing link without a link ever having been reachable (a stray entry is allowed); **When** the dependency returns and the same request is retried with the same `Idempotency-Key`, **Then** `201`.
9. **AS-09** (idempotent replay) — **Given** `U1` created a link with `Idempotency-Key: K1`, **When** the same body is sent again with `K1`, **Then** `201` with the identical body and `Idempotency-Replayed: true`, and one link exists; **When** `U2` sends `K1` with the same body, **Then** a separate link is created (keys are per user); **When** `K1` is sent after its 24-hour lifetime, **Then** a new link is created.
10. **AS-10** (idempotency in flight and misuse) — **Given** `U1`, **When** two requests with the same key `K2` and the same body arrive at once (`Promise.all`), **Then** one `201` and one `409 idempotency_in_flight` (retrying after the first completes returns the stored `201`), and one link exists; **When** `K2` is reused with a different destination, alias or `ttlDays`, **Then** `422 idempotency_key_reuse` and nothing changes.
11. **AS-11** (expiry) — **Given** `U1`, **When** creating with `ttlDays: 30`, **Then** `expiresAt` is `T + 30 days` exactly; **When** `ttlDays: 3650`, **Then** `201`; **When** `ttlDays` is omitted, **Then** `expiresAt: null` (never expires).
12. **AS-12** (per-owner limit) — **Given** a limit of 1,000 links that are active and not expired per owner (configured), **When** `U1` owns exactly that many and creates one more, **Then** `422 link_limit_reached` and nothing is stored; **When** `U1` owns 999 and two creates race, **Then** exactly one `201` and one `422`, and the count is 1,000; **When** one of `U1`'s links is disabled or expires, **Then** `U1` can create again; **When** `U2` creates, **Then** `U2` is unaffected.
13. **AS-13** (rate limit) — **Given** the profile `share-link.create` (20 creates per minute per user), **When** `U1` sends the 21st create within the minute, **Then** `429` with `Retry-After`, nothing stored; `U1`'s post and vote budgets and photo-upload budget are unchanged, and exhausting the discussion budget does not slow link creation; **When** the limiter's store is down (forced), **Then** create answers `503` (closed) and redirects are unaffected.
14. **AS-14** (destination reputation hook) — **Given** a reputation check that answers "block" for a destination, **When** `U1` creates, **Then** `422 destination_blocked` and nothing is stored; **Given** the check times out (longer than 2 s, forced), **Then** `503 destination_check_unavailable`, nothing stored; **Given** the check answers "allow", **Then** `201`.
15. **AS-15** (authentication) — **Given** no credentials, **When** `POST /api/links`, `GET /api/links`, `PATCH /api/links/<code>`, `POST /api/links/<code>/disable` or `GET /api/links/<code>/stats` is called, **Then** each answers `401`; **When** `GET /api/l/<code>` is called without credentials, **Then** it is served (the redirect is public).
16. **AS-16** (error shape) — **Given** each error above, **Then** the body parses with the problem schema and carries a `requestId`; for every `5xx` the `detail` is generic and contains no stack trace, SQL, store message or secret.

### User Story 2 — A user claims a custom alias (Priority: P1)

A seller names a link for a campaign, such as `B/summer-drop`. Aliases are first come, first served; two people can never own the same alias, even when they ask at the same instant; an alias is never handed to someone else later.

**Why this priority**: branded links are the second way to create a link and the only one with a uniqueness race.

**Independent Test**: create with an alias; race ten claims; assert one owner.

**Acceptance Scenarios**:

1. **AS-17** (alias happy path) — **Given** `U1`, **When** `POST /api/links {destination, alias: "summer-drop"}`, **Then** `201`, `code: "summer-drop"`, `kind: "custom"`, `shortUrl: "B/summer-drop"`, and `GET /api/l/summer-drop` answers `302`.
2. **AS-18** (alias format) — **Given** `U1`, **When** the alias is `abcd` (4), a 32-character alias, `a1-b2`, **Then** `201`; **When** it is 3 characters, 33 characters, `Drop-Sale` (upper case), `-drop`, `drop-`, `dr--op`, `dr_op`, `dr op`, `dró`, `a/b`, `..`, **Then** `400 validation_failed` naming `alias` and nothing is stored (aliases are lower-case letters, digits and single dashes, 4–32 characters, no leading or trailing dash).
3. **AS-19** (reserved aliases) — **Given** the reserved list `api`, `admin`, `links`, `login`, `static`, `health`, `status`, `assets`, `checkout`, `cart`, `help` and `support` (entries shorter than 4 characters could never pass the format check anyway), **When** `U1` claims `admin`, `login` or `status`, **Then** `422 alias_reserved` and nothing is stored.
4. **AS-20** (alias taken) — **Given** `U2` owns `summer-drop`, **When** `U1` claims it, **Then** `409 alias_taken`, `U2`'s link is unchanged; **When** `U2` claims it again with a new key, **Then** also `409 alias_taken` (an alias is not "re-claimed").
5. **AS-21** (concurrent claims) — **Given** ten users, **When** all claim `drop-xyz` at once (`Promise.all`), **Then** exactly one `201` and nine `409 alias_taken`, exactly one link exists, and `GET /api/l/drop-xyz` redirects to the winner's destination.
6. **AS-22** (codes are never reused) — **Given** `U1`'s alias `old-promo` expired yesterday (or is disabled), **When** `U2` claims `old-promo`, **Then** `409 alias_taken`; the code stays reserved until the link record is purged 13 months after it expired or was disabled; after the purge the alias can be claimed again.
7. **AS-23** (a just-claimed alias is reachable at once) — **Given** `GET /api/l/late-promo` already answered `404` (the miss may be remembered), **When** `U1` claims `late-promo`, **Then** the next `GET /api/l/late-promo` answers `302` immediately, not `404`.

### User Story 3 — A visitor follows a short link and lands on the product (Priority: P1)

Anyone, signed in or not, opens a short link and is redirected to the destination with the attribution reference appended. Hot links are served from the edge, unknown links cost almost nothing, and a viral link does not hurt the origin.

**Why this priority**: it is the product; 100 reads for every write, and 40,000 redirects per second at peak.

**Independent Test**: create a link, request `GET /api/l/<code>` with no credentials; assert status, headers and what was read.

**Acceptance Scenarios**:

1. **AS-24** (redirect, happy path) — **Given** an active link to `F/p/iphone-17?color=blue`, **When** `ANON` calls `GET /api/l/<code>`, **Then** `302`, `Location: F/p/iphone-17?color=blue&ref=<code>`, `Cache-Control: public, max-age=0, s-maxage=10`, no `Set-Cookie`, an empty body; one `link.clicked` event is published after the response (AS-38).
2. **AS-25** (reference placement) — **Given** a link whose destination has a fragment and parameters (`F/p/x?a=1&b=two%20words#reviews`), **When** it is followed, **Then** `Location` is `F/p/x?a=1&b=two%20words&ref=<code>#reviews`; the fragment stays last and the other parameters are unchanged.
3. **AS-26** (unknown code) — **Given** no link `Zz9Zz9Z`, **When** `GET /api/l/Zz9Zz9Z`, **Then** `404 link_not_found`, `Cache-Control: no-store`, no click event, and the link store is not read (the existence filter answers "definitely absent"); `link_resolve_total{source="filter_reject"}` is incremented.
4. **AS-27** (malformed codes) — **Given** codes of 3 characters, 33 characters, `a$b`, `..%2F..`, `dró`, **When** each is requested, **Then** `404 link_not_found` with the same body as an unknown code, no store read, no event.
5. **AS-28** (expired) — **Given** a link with `expiresAt = T + 10 s`, **When** requested at `T + 9 s`, **Then** `302`; **When** requested at `T + 10 s` (exactly) and later, **Then** `410 link_gone`, `Cache-Control: public, s-maxage=60`, no click event.
6. **AS-29** (disabled) — **Given** a disabled link, **When** requested, **Then** `410 link_gone` with a body identical to the expired case, no click event.
7. **AS-30** (HEAD and other methods) — **Given** an active link, **When** `HEAD /api/l/<code>`, **Then** the same status and headers as `GET` and no click event; **When** `POST`, `PUT`, `PATCH` or `DELETE` is sent to `/api/l/<code>`, **Then** `405` and nothing changes.
8. **AS-31** (remembered misses) — **Given** the existence filter is bypassed (AS-33) and a code that does not exist, **When** it is requested 100 times within 60 s, **Then** the link store is read once and all 100 answer `404`; **When** requested after 60 s, **Then** the store is read again.
9. **AS-32** (hot link, one load) — **Given** a cold cache and an active link, **When** 500 requests for the same code arrive at once, **Then** exactly one store read happens, all 500 answer `302` with the same `Location`.
10. **AS-33** (existence filter lost) — **Given** the existence filter lost its contents (no "ready" marker), **When** an existing link is requested, **Then** `302` (the filter is bypassed, never trusted to say "absent"), and `link_filter_bypassed_total` is incremented; **When** the rebuild job runs, **Then** it re-adds every stored code, sets the ready marker last, and an unknown code is rejected without a store read again; **When** two rebuilds start at once, **Then** one runs and the other is a no-op; **When** the job is interrupted before it finishes, **Then** the marker is not set and the filter stays bypassed.
11. **AS-34** (store outage) — **Given** a warm cache, **When** the link store is unavailable (forced), **Then** requests for cached links still answer `302` (stale entries are served for up to 24 h); **Given** a cold cache and the store timing out after 500 ms, **Then** `503 service_unavailable` with `Retry-After: 5`, never `404`, and the failure is not remembered as a miss; **When** the store returns, **Then** the next request answers `302`.
12. **AS-35** (destination re-checked at redirect) — **Given** a stored link whose destination host is no longer an allowed marketplace host (the allowlist changed), **When** it is requested, **Then** `410 link_gone`, no click, and `link_destination_rejected_total` is incremented; the visitor is never redirected off the marketplace.
13. **AS-36** (click pipeline degraded) — **Given** the event pipeline refuses messages (forced), **When** a link is followed, **Then** `302` as usual, `link_click_publish_failed_total` is incremented once, a structured warning with no destination, referrer, address or visitor data is logged; **Given** the pipeline hangs, **Then** the response time is unchanged (the redirect never waits for it).
14. **AS-37** (graceful shutdown) — **Given** click events in flight, **When** the process receives its stop signal, **Then** it stops accepting requests, waits up to 5 s for in-flight click publishes, then closes its connections; no click event accepted before the signal is dropped when the pipeline is healthy.

### User Story 4 — Every followed link is one attributed click (Priority: P1)

The owner and the platform learn how many people followed a link, from which country and which site, and checkout can credit the link's owner. Each served redirect is counted once, however often a message is redelivered, and counting never slows a visitor.

**Why this priority**: attribution is why influencers create links.

**Independent Test**: follow a link, deliver the resulting event (twice, late, malformed) to the click consumer; assert counted clicks, rejected messages and the attribution lookup.

**Acceptance Scenarios**:

1. **AS-38** (click event) — **Given** `GET /api/l/<code>` with `CF-IPCountry: DE` and `Referer: https://t.co/a?utm=1`, **When** it answers `302`, **Then** one event is published keyed by the code with `eventId = clickId` (a time-ordered UUID), `type: "link.clicked"`, `version: 1`, `occurredAt: T`, aggregate `links/<code>`, payload `{clickId, code, ts: T, country: "DE", referer: "https://t.co", viaEdge: false}`; it parses with `linkClickedEventSchema`; it holds no address, user agent, cookie, user ID or path or query of the referrer.
2. **AS-39** (country and referrer clean-up) — **Given** the inputs, **Then** country `de` → `DE`, `DE` → `DE`, `XX`, `T1`, `DEU`, empty, absent, `d3` → `""`; referrer `https://t.co/a?x=1` → `https://t.co`, `http://a.b:8080/x` → `http://a.b:8080`, `android-app://com.x` → `""`, `not a url` → `""`, a value longer than 300 characters → `""`, one with credentials `https://u:p@t.co/x` → `https://t.co`.
3. **AS-40** (edge flag needs a credential) — **Given** an edge credential shared by the origin and the edge worker, **When** a request carries `x-edge-click-recorded: 1` and a valid credential, **Then** `302` and no click event (the edge recorded it); **When** it carries the flag without the credential or with a wrong one, **Then** the flag is ignored: `302` and one click event with `viaEdge: false`.
4. **AS-41** (edge worker) — **Given** the edge worker with a fake origin and a fake event sink, **When** a code is requested and the origin answers `302`, **Then** the worker answers `302` and sends exactly one click event (`viaEdge: true`, the same envelope as AS-38) without delaying the response; **When** the same code is requested again and is served from the edge cache, **Then** a second click event with a different `clickId` is sent and the origin is not called; **When** the origin answers `404`, `410` or `5xx`, **Then** the worker passes the answer through, caches nothing, and sends no click event; **When** the sink fails, **Then** the visitor still gets the `302`.
5. **AS-42** (edge staleness is bounded) — **Given** a `302` cached at the edge at time `t0`, **When** the owner changes or disables the link, **Then** edge requests before `t0 + 10 s` may still answer the old `302` and requests after `t0 + 10 s` reach the origin and answer the new state; the origin answers the new state at once (AS-53, AS-55).
6. **AS-43** (duplicate delivery) — **Given** a `link.clicked` event, **When** it is delivered twice (and again after a restart), **Then** the owner's statistics count one click at every moment, including before any background merge.
7. **AS-44** (invalid payloads) — **Given** events with: no `clickId`; `clickId` not a UUID; `code` failing the code format; `ts` not an ISO-8601 instant; `ts` more than 5 minutes in the future; `country` of 3 letters; `referer` longer than 300 characters; an unknown event type; `version: 2`; a body that is not JSON, **When** each is delivered together with one valid event, **Then** each invalid one is rejected to the dead-letter destination with its reason and has no effect, and the valid one is counted.
8. **AS-45** (late and out-of-order events) — **Given** events for minutes `M+1`, `M` and `M-120` delivered in that order, **When** consumed, **Then** each is counted in the minute of its own `ts` (not its arrival), totals equal those of in-order delivery, and shuffled delivery of the same set gives identical statistics.
9. **AS-46** (attribution lookup) — **Given** an active link `A` owned by `U1`, an expired link `B` owned by `U1`, a disabled link `C` owned by `U2` and an unknown code, **When** a consumer calls `resolveAttributions(["A","B","C","nope"])`, **Then** it returns `A → {code, ownerId: U1, status: "ACTIVE"}`, `B → {…, status: "EXPIRED"}`, `C → {ownerId: U2, status: "DISABLED"}` and no entry for `nope`; the result holds no destination, no click data and no model object; malformed codes are omitted; `[]` returns `{}`; more than 100 codes are refused with `TooManyCodesError`; the call makes one batched store read.
10. **AS-47** (attribution lookup degraded) — **Given** the link store is unavailable (forced), **When** `resolveAttributions` is called, **Then** it throws `AttributionUnavailableError` (it never returns an empty result that looks like "no such link").

### User Story 5 — The owner manages their links (Priority: P2)

The owner lists their links, changes a destination (a viral link can be re-pointed), and disables a link that should stop working.

**Why this priority**: the mistakes and takedowns that make the product safe to use; creation and redirect work without it.

**Independent Test**: create links as two users; list, edit and disable as each; assert state, redirects and cross-user answers.

**Acceptance Scenarios**:

1. **AS-48** (list, cursor pages) — **Given** `U1` owns 5 links (some expired or disabled) and `U2` owns 2, **When** `GET /api/links?limit=2`, **Then** `200 {items: [2 newest of U1], nextCursor}` ordered by `createdAt` descending and then `code` descending, every item parses with `shortLinkSchema` (with its `status`, `expiresAt`), none of `U2`; **When** the pages are followed with `nextCursor`, **Then** all 5 appear once each, in order, and a link created between pages neither duplicates nor skips one; the last page has `nextCursor: null`.
2. **AS-49** (list limits) — **Given** `U1`, **When** `limit` is omitted, **Then** 20 items at most; `limit=100` is accepted; `limit=0`, `101`, `abc` → `400 validation_failed`; a cursor that was edited or belongs to another user → `400 invalid_cursor`; a user with no links gets `{items: [], nextCursor: null}`.
3. **AS-50** (change destination) — **Given** an active link, **When** `U1` calls `PATCH /api/links/<code> {destination: "F/p/other"}`, **Then** `200` with the updated link (`updatedAt: T`; `code`, `createdAt`, `expiresAt`, `status` unchanged) and the next `GET /api/l/<code>` at the origin answers `302` to the new destination with `ref`.
4. **AS-51** (change validation) — **Given** `U1`, **When** the body is empty, has an unknown or immutable property (`code`, `alias`, `ttlDays`, `expiresAt`, `status`, `ownerId`), or a destination that fails AS-02, **Then** `400 validation_failed`; **When** the destination fails the marketplace policy (AS-03) or the reputation check (AS-14), **Then** `422 destination_not_allowed` or `destination_blocked`; nothing changes.
5. **AS-52** (disable) — **Given** an active link, **When** `U1` calls `POST /api/links/<code>/disable`, **Then** `200` with `status: "DISABLED"`, `disabledAt: T`, `updatedAt: T`; the next `GET /api/l/<code>` answers `410 link_gone`; the link still shows in `GET /api/links`, its statistics are still readable, and the owner's active-link count drops by one.
6. **AS-53** (illegal transitions) — **Given** a disabled link or an expired link, **When** `U1` disables it, or changes its destination, **Then** `409 link_not_active` and nothing changes; there is no way to re-enable (a new link is created instead).
7. **AS-54** (concurrent edit and disable) — **Given** an active link, **When** a change of destination and a disable race (`Promise.all`), **Then** the disable always answers `200`; the change answers `200` (it ran first) or `409 link_not_active` (it ran second); the final status is `DISABLED`; if the change answered `409`, the stored destination is the old one; **When** two disables race, **Then** exactly one `200` and one `409`; **When** two changes race, **Then** both answer `200` and the stored destination is exactly one of the two (never a mix).
8. **AS-55** (cache never outlives a change) — **Given** a warm cache for the link, **When** the owner changes the destination or disables the link, **Then** the very next origin request reflects it (`302` to the new destination, or `410`); the remembered entry was removed on write, not left to expire.
9. **AS-56** (other users, IDOR) — **Given** `U1`'s link, **When** `U2` calls `PATCH`, `POST …/disable` or `GET …/stats` for its code, **Then** `404 link_not_found`, with the same body as for an unknown code, and nothing changes; **When** the code in the path is malformed, **Then** the same `404`; `U2`'s list never shows `U1`'s links.

### User Story 6 — The owner sees how a link performs (Priority: P2)

The owner opens a link's statistics: total clicks, a time series and the top countries.

**Why this priority**: it is what the owner gets in return; it also proves attribution works.

**Independent Test**: record clicks at known minutes, read the statistics for each range.

**Acceptance Scenarios**:

1. **AS-57** (statistics, happy path) — **Given** a link with 5 clicks (3 from `DE`, 2 from `FR`) at known minutes within the last day, **When** `U1` calls `GET /api/links/<code>/stats?range=24h`, **Then** `200`, the body parses with `linkStatsSchema`: `{code, range: "24h", from, to, bucket: "minute", total: 5, series: [{start, clicks}] (only buckets with clicks, ascending), countries: [{country: "DE", clicks: 3}, {country: "FR", clicks: 2}]}`; counts are JSON numbers (not strings); `countries` holds at most 10 entries, sorted by clicks descending and then country.
2. **AS-58** (ranges and buckets) — **Given** clicks over 30 days, **When** `range=24h`, `7d`, `30d` (default `7d`), **Then** buckets are minute, hour and day (UTC), `from` is `T - range`, `to` is `T`, a click exactly at `from` is included and one just after `to` is not; **When** `range=1h`, `1y` or empty, **Then** `400 validation_failed`.
3. **AS-59** (no clicks, retained links) — **Given** a link with no clicks, **Then** `total: 0`, `series: []`, `countries: []`; **Given** the link is expired or disabled, **Then** its statistics are still returned.
4. **AS-60** (freshness) — **Given** a click published at `T`, **When** the click consumer has processed it, **Then** it appears in `stats` immediately after (consumer lag is a metric, with a 60-second target at the 99th percentile; SC-004).
5. **AS-61** (statistics store down) — **Given** the analytics store is unavailable (forced), **When** `stats` is called, **Then** `503 service_unavailable`; **And** list, create, change, disable and redirect still work.

### User Story 7 — Safe to operate, inside its boundaries (Priority: P2)

Operations can see what the capability does, a bad configuration cannot start it, and the capability touches only what it owns.

**Why this priority**: security and observability are explicit goals; the other stories depend on them.

**Independent Test**: boot with bad configuration; scrape metrics; run the static checks.

**Acceptance Scenarios**:

1. **AS-62** (configuration) — **Given** startup with: the code key missing, shorter than 32 bytes, or equal to the session-signing secret or the ad click secret; the short-link base not an absolute `https` URL; the storefront origin not an absolute `https` URL; the per-owner limit not a positive integer; the edge credential missing or shorter than 32 bytes, **Then** startup fails naming each key and never falls back to another secret; with a valid configuration it starts.
2. **AS-63** (metrics and logs) — **Given** a mix of creates, redirects, edge-flagged redirects and consumed events, **Then** the metrics `link_created_total{kind}`, `link_redirect_total{outcome=redirected|not_found|gone|unavailable}`, `link_resolve_total{source=filter_reject|cache|store}`, `link_filter_bypassed_total`, `link_code_collision_total`, `link_destination_rejected_total`, `link_click_publish_failed_total`, `link_click_projected_total`, `link_click_dead_lettered_total` and a consumer-lag gauge match what was done; every log line is structured JSON with `requestId`; no log line, metric label or event field contains a destination, a referrer, a query string, a secret or a visitor identifier.
3. **AS-64** (boundaries) — **Given** the code base, **Then**: `pnpm --dir packages/backend check:table-ownership` reports no finding for `libs/domains/marketing` files that belong to share links; `check:boundaries` reports no error for them (no `infra/` import in `api/` or `application/`, no `api/` or `application/` import in `domain/`, no infrastructure import of this domain); the domain barrel exports only the modules, exported services, DTO types and event contracts listed under Provides; no other domain reads or writes this capability's link store, filter, cache keys, counter, topic (as a producer) or analytics tables.
4. **AS-65** (clock) — **Given** the pure link logic (expiry, state transitions, code scheme), **Then** it reads time only through an injected clock; expiry is decided by `now >= expiresAt` and the boundary cases of AS-28 hold for every clock value tested.
5. **AS-66** (UI journey, happy path) — **Given** a signed-in buyer on a product page, **When** they choose "Share", the page creates a short link and shows `B/<code>` with a copy button, and a visitor with no session opens it, **Then** the visitor lands on that product page with `?ref=<code>`, and the owner's link statistics show the click once the consumer has run. (Owned by W02; only the happy path.)

### Edge Cases

- **Code scheme**: 7 characters, bijective and keyed (AS-05); collision with an alias or after a key change retries (AS-07); the number space is far from exhausted at the 5-billion-link target (SC-006); a number beyond the space is refused.
- **Alias races and reuse**: ten simultaneous claims → one winner (AS-21); expired and disabled codes are never reassigned within 13 months (AS-22); a miss remembered for an alias must not hide a new claim (AS-23).
- **Open redirect**: host look-alikes, user-info, backslashes, ports, trailing dots, schemes (AS-03); re-checked at redirect time (AS-35).
- **Idempotent replay and races on create**: replay, in-flight, key misuse (AS-09, AS-10); per-owner limit under concurrency (AS-12).
- **Illegal state transitions and concurrency**: disable twice, edit after disable, edit versus disable (AS-53, AS-54).
- **Cross-user access**: edit, disable and statistics of someone else's link answer `404` like an unknown code (AS-56); the public redirect leaks nothing about the owner.
- **Limits**: alias 4–32, destination 2,048, `ttlDays` 1–3,650, list page 100, 100 codes per attribution lookup, 1,000 links per owner, 20 creates per minute (AS-02, AS-12, AS-13, AS-46, AS-49).
- **Time**: expiry is exclusive at `expiresAt` (AS-28); edge caches may be up to 10 s stale (AS-42); a click `ts` more than 5 minutes ahead is rejected, late and out-of-order clicks land in their own minute (AS-44, AS-45).
- **Duplicate and malformed events**: same click delivered twice counts once; invalid payloads are dead-lettered with no effect (AS-43, AS-44).
- **Degradation**: existence filter lost (AS-33), store outage with warm and cold cache (AS-34), event pipeline down or hanging (AS-36), analytics store down (AS-61), reputation check slow (AS-14), limiter store down (AS-13).
- **Viral link**: 500 simultaneous requests on a cold cache cause one store read (AS-32); the edge serves the rest (AS-41).
- **Spoofing**: the "edge already counted this" flag without the shared credential is ignored (AS-40).

## Requirements *(mandatory)*

### Functional Requirements

**Codes (P0320, P1109)**

- **FR-001**: A generated code MUST be exactly 7 characters of `0-9A-Za-z`, produced from a sequence number by a **keyed bijection** over the code space followed by base-62 encoding, so that two different numbers never give the same code, and consecutive numbers give codes that look unrelated (AS-05).
- **FR-002**: The bijection MUST be reversible with the key, MUST accept every number of the code space and refuse any number outside it, and MUST use a dedicated secret key that is never shared with sessions or ad click tokens (AS-05, AS-62).
- **FR-003**: Sequence numbers MUST come from **leased blocks**: each application instance takes a block of 1,000 numbers from a shared counter with one call and hands them out locally; concurrent demands on an exhausted block share one counter call (AS-06).
- **FR-004**: Numbers in an unused part of a block MUST never be handed out again; gaps MUST NOT be observable as patterns in codes (AS-06).
- **FR-005**: Creation MUST write the link only if its code is not already present (an atomic conditional write). A generated code that collides MUST be retried with a new number up to 5 attempts, never overwriting; exhaustion answers `503 code_generation_failed` (AS-07).
- **FR-006**: The code space MUST hold at least 10^12 codes, so that 5 billion links use less than 0.5% of it (SC-006).
- **FR-007**: An unavailable counter, existence filter or link store at create MUST answer `503 service_unavailable` and leave no link behind; the filter entry for a code MUST be added **before** the link becomes visible, so a crash can leave a stray filter entry but never a link the filter hides (AS-08).

**Creating links**

- **FR-010**: `POST /api/links` MUST accept `{destination, alias?, ttlDays?}`, reject unknown properties, and require an `Idempotency-Key` header of 8–128 characters (AS-01, AS-02).
- **FR-011**: The response MUST be `201` with `Location: /api/links/<code>` and a body of exactly `{code, shortUrl, destination, status, kind, createdAt, updatedAt, expiresAt}` (plus `disabledAt` once disabled), validated by `shortLinkSchema`; it MUST NOT expose an owner ID, a store key or any internal field (AS-01).
- **FR-012**: A destination MUST be an absolute `https` URL of at most 2,048 characters with no whitespace or control characters, whose parsed host (case-folded, without user-info, with no port other than the default, no trailing dot, compared after IDNA normalisation) equals the storefront host or its `www.` form. Anything else answers `422 destination_not_allowed`; nothing about the failing part of the URL is echoed back except the field name (AS-03).
- **FR-013**: The destination MUST be stored normalised: host in lower case, any `ref` parameter removed, other parameters and the fragment untouched (AS-03, AS-04).
- **FR-014**: Before a link is stored or its destination changed, the destination MUST pass a **reputation check** behind a port, with a 2-second timeout. "Block" answers `422 destination_blocked`; timeout or failure answers `503 destination_check_unavailable`; the check fails closed (AS-14).
- **FR-015**: `ttlDays`, when present, MUST be an integer from 1 to 3,650; `expiresAt` is exactly `createdAt + ttlDays days`; without it a link never expires (AS-11).
- **FR-016**: Creation MUST be idempotent per user and key: a replay with the same body returns the stored status and body with `Idempotency-Replayed: true`; a request with the same key in flight answers `409 idempotency_in_flight`; the same key with a different body answers `422 idempotency_key_reuse`; keys live 24 hours (AS-09, AS-10).
- **FR-017**: A user MUST own at most a configured number (default 1,000) of links that are active and not expired. The limit MUST hold under concurrent creates (exactly one of two racing creates at the limit succeeds); disabling or expiry frees a place (AS-12).
- **FR-018**: Creation MUST be rate limited by its own profile `share-link.create` (20 per minute per user, closed on limiter failure); no other capability's profile is borrowed, and no other capability consumes this profile (AS-13).
- **FR-019**: Every endpoint except the public redirect MUST require an authenticated user and answer `401` otherwise (AS-15).
- **FR-020**: Every error MUST be problem+json produced by the shared filter; `5xx` details are generic (AS-16).

**Aliases**

- **FR-030**: An alias MUST be 4–32 characters of lower-case letters, digits and single dashes, with no leading or trailing dash (AS-17, AS-18).
- **FR-031**: Aliases that equal a reserved word (configured list, default `api`, `admin`, `links`, `login`, `static`, `health`, `status`, `assets`, `checkout`, `cart`, `help`, `support`) MUST answer `422 alias_reserved` (AS-19).
- **FR-032**: An alias is claimed by the same atomic conditional write as FR-005: at most one claimant wins; the others answer `409 alias_taken` and cannot alter the winner's link (AS-20, AS-21).
- **FR-033**: A code MUST NOT be reassigned while its link record exists, including after the link expired or was disabled. Records are purged 13 months after expiry or disablement (the click-retention period); only then may the code be claimed again (AS-22).
- **FR-034**: Claiming an alias MUST make it reachable at once, even if a miss for it was remembered (AS-23).

**Redirect**

- **FR-040**: `GET /api/l/<code>` MUST be public and answer `302` with `Location` = destination with the parameter `ref=<code>` set (after the other parameters, before the fragment), `Cache-Control: public, max-age=0, s-maxage=10`, no cookie and an empty body. The code is always `302`, never `301`, so every click is counted and destinations stay editable (AS-24, AS-25).
- **FR-041**: Resolution order MUST be: code format check → existence filter ("definitely absent" answers `404` with no store read) → cache-aside lookup with remembered misses (60 s), stale serving (up to 24 h) and one load per code at a time → link store (AS-26, AS-27, AS-31, AS-32).
- **FR-042**: A malformed or unknown code answers `404 link_not_found` with `Cache-Control: no-store`; the two cases have identical bodies (AS-26, AS-27).
- **FR-043**: An expired link (decided by `now >= expiresAt`) and a disabled link answer `410 link_gone` with identical bodies and `Cache-Control: public, s-maxage=60`; neither records a click (AS-28, AS-29).
- **FR-044**: `HEAD` MUST behave like `GET` without recording a click; other methods answer `405` (AS-30).
- **FR-045**: The existence filter MUST never be trusted when it may be incomplete: without its "ready" marker it is bypassed (and `link_filter_bypassed_total` counts it). A rebuild job MUST re-add every stored code, set the marker last, run once per schedule across replicas, and be safe to rerun (AS-33).
- **FR-046**: A store failure MUST answer `503` with `Retry-After` (never `404`), MUST NOT be remembered as a miss, and a warm cache MUST keep serving (AS-34). Every call to the store, cache and filter has an explicit timeout (store: 500 ms).
- **FR-047**: The destination of a resolved link MUST be re-checked against the marketplace policy at redirect time; a link that fails answers `410 link_gone` (AS-35).
- **FR-048**: Changing or disabling a link MUST remove its remembered entry in the same operation, so the origin reflects the change at once (AS-55).

**Clicks and attribution**

- **FR-060**: Every `302` served by the origin or the edge MUST yield exactly one `link.clicked` event, published off the request path; none for `404`, `410`, `405`, `HEAD`, `5xx` (AS-24, AS-26, AS-28, AS-29, AS-30, AS-41).
- **FR-061**: The event MUST carry `eventId` (= `clickId`, a time-ordered UUID), `type: "link.clicked"`, `version: 1`, `occurredAt`, the aggregate `links/<code>`, and the payload `{clickId, code, ts, country, referer, viaEdge}`; it is keyed by the code. `country` is an ISO 3166-1 alpha-2 code in upper case or `""`; `referer` is the origin (scheme, host, port) of the `Referer` or `""`; no address, user agent, cookie, user ID, destination, path or query is recorded (AS-38, AS-39).
- **FR-062**: A publish failure MUST NOT delay or change the response; it increments `link_click_publish_failed_total` and logs one structured warning. Clicks are best effort (at most once) and the loss rate is observable (AS-36).
- **FR-063**: The "already counted at the edge" flag MUST be honoured only with a valid shared edge credential; otherwise it is ignored (AS-40).
- **FR-064**: The edge worker MUST record a click only for redirects it actually serves (cache hit or origin `302`), once per request, and MUST NOT cache or count anything else (AS-41). Its cached `302` lifetime is the origin's `s-maxage` (10 s) at most (AS-42).
- **FR-065**: The click consumer MUST validate every payload; an invalid one is rejected to the dead-letter destination with its reason and has no effect; one bad message never blocks others (AS-44).
- **FR-066**: The click consumer MUST be idempotent on `clickId`: a click is counted at most once whatever the delivery count, at every moment (AS-43).
- **FR-067**: Clicks MUST be bucketed by their own `ts`, not by arrival; arrival order does not change results; a `ts` more than 5 minutes ahead of now is invalid; click records are kept for 13 months (AS-45).
- **FR-068**: The capability MUST export `resolveAttributions(codes: string[])` (IX.7 **R1**) returning, per known code, `{code, ownerId, status}` with `status` in `ACTIVE | EXPIRED | DISABLED`; unknown and malformed codes are omitted; at most 100 codes per call; one batched read; failure is an error, never an empty result (AS-46, AS-47).
- **FR-069**: The destination carries the attribution reference as `ref=<code>`; keeping it as a first-party cookie for 30 days and attaching it at checkout belong to W02 and S10 (Cross-capability contracts). The ref code is valid for attribution after the link expires, until its record is purged (AS-46).

**Managing links**

- **FR-080**: `GET /api/links` MUST return only the caller's links as `{items, nextCursor}` with an opaque cursor, ordered `createdAt` descending then `code` descending, `limit` 1–100 (default 20) (AS-48, AS-49).
- **FR-081**: `PATCH /api/links/<code>` MUST change only `destination`, under the same rules as FR-012 – FR-014, only while the link is active and not expired (AS-50, AS-51, AS-53).
- **FR-082**: `POST /api/links/<code>/disable` MUST move an active, unexpired link to `DISABLED`; there is no way back; any other state answers `409 link_not_active`. Transitions are conditional on the current state, so races have one winner (AS-52 – AS-54).
- **FR-083**: Every lookup of a link by an authenticated route MUST include the caller as owner in the lookup itself; links of others answer `404 link_not_found` identically to unknown codes (AS-56).

**Statistics**

- **FR-090**: `GET /api/links/<code>/stats?range=24h|7d|30d` (default `7d`) MUST return the owner's own link only (FR-083), as `{code, range, from, to, bucket, total, series, countries}` with numeric counts, minute, hour or day buckets (UTC) for the three ranges, only non-empty buckets, at most 10 countries (AS-57, AS-58).
- **FR-091**: Statistics MUST count each click once (FR-066), include expired and disabled links, and be available within 60 seconds of the click at the 99th percentile (AS-59, AS-60).
- **FR-092**: An unavailable analytics store answers `503` on this endpoint only (AS-61).

**Operations and boundaries**

- **FR-100**: Startup MUST fail, naming the key, on any invalid configuration in AS-62; the code key never falls back to another secret.
- **FR-101**: The capability MUST emit the metrics and structured logs of AS-63 and keep visitor, destination and referrer data out of logs, labels and events.
- **FR-102**: Shutdown MUST stop accepting requests, wait up to 5 s for in-flight click publishes, then close pools (AS-37).
- **FR-103**: The capability MUST own its link store, filter, cache keys, counter, event topic and analytics tables alone, MUST read no other domain's data (it needs none), and MUST read no other domain's tables (AS-64).
- **FR-104**: Time MUST be read through an injected clock in pure logic (AS-65).
- **FR-105**: All request and response shapes are published as `packages/contracts` schemas and used by the e2e specs (VII.6): `createShortLinkRequestSchema`, `updateShortLinkRequestSchema`, `shortLinkSchema`, `shortLinkPageSchema`, `linkStatsSchema`, `linkClickedEventSchema`.

### Key Entities *(include if feature involves data)*

- **Short link**: code (unique, never reused within 13 months), kind (generated or custom), destination, owner (a user ID, no foreign key), status (`ACTIVE` or `DISABLED`), created, updated, optional expiry and disable time. "Expired" is derived.
- **Click**: one served redirect: click ID, code, instant, country, referrer origin, whether the edge recorded it. Immutable.
- **Attribution reference**: the code carried as `ref` in the destination; resolves to the owner and the link's state.
- **Link counter lease**: a block of 1,000 sequence numbers owned by one instance.
- **Existence filter**: a probabilistic set of known codes with a "ready" marker; it may say "maybe", never a false "absent" while ready.
- **Idempotency record**: user, key, request fingerprint and stored response, 24 hours.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 99% of redirects for cached links are answered by the origin in under 20 ms; edge-served redirects never reach the origin while their cached answer is fresh.
- **SC-002**: A viral link sustains 40,000 redirects per second at peak with the origin seeing at most one request per code per edge location every 10 seconds.
- **SC-003**: 100% of created codes are unique and none can be guessed from another (10,000 consecutive creations show no adjacent codes), under 1,000 concurrent creations.
- **SC-004**: 99% of clicks appear in the owner's statistics within 60 seconds of the click; duplicates never inflate a count (0 duplicate counts in the replay test).
- **SC-005**: 0 redirects leave the marketplace: every attempted off-marketplace destination (13 variants tested) is refused on create and on change.
- **SC-006**: 5 billion links over 5 years use less than 0.5% of the code space; create sustains 400 per second.
- **SC-007**: An unknown or malformed code costs no link-store read in at least 99.9% of requests while the filter is ready.
- **SC-008**: A creation retried with the same key by a client after a timeout produces exactly one link in 100% of cases.
- **SC-009**: Zero visitor-identifying values (address, user agent, cookie, full referrer URL) are stored or logged for 100% of sampled clicks.

## Assumptions

All defaults below are also in `questions.md` with their tags.

- The Interview-Prep notes (§8 URL shortener) are authoritative: `302` not `301`, keyed bijective scramble over base-62, leased ID blocks, conditional-write aliases, cache-aside with remembered misses, edge redirect, clicks off the request path, destinations limited to the marketplace.
- A short link has one owner, a signed-in user. Shop-owned links are not modelled; shop members create links as themselves.
- The code key is 40 bits wide in the bijection because 62^7 ≈ 3.5×10^12 is smaller than 2^42; the note's "42 bits" cannot fit 7 characters.
- Aliases are lower case only so that case differences cannot produce look-alike links.
- Disabling is final; expiry cannot be changed; this keeps the state machine to two stored states and avoids resurrecting codes that were already reassigned in people's minds.
- A link is retained 13 months after it expires or is disabled, matching click retention, so codes are not recycled while old posts may still carry them.
- "Click" means one served redirect. HEAD requests are excluded; bots, link previews and the owner's own visits are counted. Fraud filtering and commission rules are a later capability; `ownerId` in the attribution lookup lets a consumer refuse self-referrals.
- Click events are best effort (at most once). Losing clicks on a pipeline outage is accepted and made visible by a metric; the redirect is never made slower or less available to protect the count.
- Stricter on purpose than today: only `https` destinations, creation requires an idempotency key, referrer data is reduced to its origin, lists are paged, expired and disabled links answer `410`.
- Everything the visitor sees at `/api/l/<code>` is also what the edge serves at `/l/<code>`; the short domain routes `/<code>` to that path (deployment detail, not specified here).
- The reputation check is a hook with an allow-all default implementation in this release; the marketplace-host restriction is the main control.
- Clock skew between the edge, the origin and the event consumer is under 5 minutes.

## Cross-capability contracts

Searched `specs/domains` for `S37` and `marketing`. Contracts found: **S25** `gaps.md` F2 (rate-limit profiles `discussion.write` / `discussion.vote` must become S25-only and share links must get their own, owner S37); **S36** `spec.md` and `questions.md` (share links stay a separate module in `marketing`; `ShareLinksModule` and `LinkClicksProjector` stay out of S36's barrel changes; S36's ad click token no longer uses `share_link_secret`). Both are honoured below. No spec requires any other export or event from S37.

**Provides**

- **Endpoints** (all under the global prefix `/api`; shapes in `packages/contracts`):
  - `POST /links` (auth; header `Idempotency-Key`) → `201 shortLinkSchema`. Errors: `400 validation_failed`, `401`, `409 alias_taken | idempotency_in_flight`, `422 destination_not_allowed | destination_blocked | alias_reserved | link_limit_reached | idempotency_key_reuse`, `429`, `503`.
  - `GET /links?limit&cursor` (auth) → `200 shortLinkPageSchema {items, nextCursor}`.
  - `PATCH /links/:code {destination}` (auth, owner) → `200 shortLinkSchema`; `404 link_not_found`, `409 link_not_active`.
  - `POST /links/:code/disable` (auth, owner) → `200 shortLinkSchema`; `404`, `409 link_not_active`.
  - `GET /links/:code/stats?range` (auth, owner) → `200 linkStatsSchema`.
  - `GET /l/:code` (public; also served by `edge-be` at `/l/:code`) → `302` with `ref=<code>`; `404 link_not_found`; `410 link_gone`; `503`. For **W02**: the share action calls `POST /links` and shows `shortUrl`; the storefront stores `ref` from the landing URL as a first-party cookie for 30 days.
- **Event `link.clicked`** (consumers: this capability's click consumer; the analytics capability may subscribe): topic `links.events`, key = code, envelope `{eventId (= clickId), type: "link.clicked", version: 1, occurredAt, aggregateType: "links", aggregateId: code, payload: {clickId, code, ts, country, referer, viaEdge}}`. Guarantees: one event per served redirect, at most once, never for non-`302` answers, no personal data (FR-060 – FR-062).
- **R1 export** `LinkAttributionService.resolveAttributions(codes: string[]): Promise<Record<string, {code: string; ownerId: string; status: 'ACTIVE' | 'EXPIRED' | 'DISABLED'}>>` from `@app/domains/marketing`. At most 100 codes; one batched read; throws `TooManyCodesError` and `AttributionUnavailableError`. For **S10 / the commission consumer** (J05): checkout validates the cookie's `ref` with it and may refuse a self-referral by comparing `ownerId`; the ref stays resolvable after expiry (status `EXPIRED`) until the record is purged.
- **Barrel** (`@app/domains/marketing`, share-link part): `ShareLinksModule` (core: HTTP and attribution export), `ShareLinksWorkerModule` (worker: filter rebuild job), `ShareLinksProjectorModule` (projector: click consumer). The class `LinkClicksProjector` is no longer exported (apps import the module). DTO types and `linkClickedEventSchema` are exported.
- **Rate-limit profile** `share-link.create` (20 per minute per user, key `user`, closed). Its removal of the share-link use of `discussion.write` completes the **S25** contract.
- **Configuration keys** owned by this capability: `share_link_code_key` (≥ 32 bytes, replaces `share_link_secret`), `share_link_base_url` (required, absolute https), `share_link_max_per_owner` (default 1000), `share_link_edge_secret` (≥ 32 bytes, shared with the edge worker), `share_link_reserved_aliases` (default list).

**Requires**

- **S01 (identity)**: the authenticated principal `{id: string}` through the entry-point decorator, and `401` for missing credentials. Share links need no other identity data (no R1 call).
- **S50 (rate limiter)**: profile registration and a `429` with `Retry-After`; `closed` fail mode.
- **S53 (consumer framework, dead letters)**: a consumer contract with payload validation and a dead-letter destination; this capability documents its idempotency mechanism (click ID).
- **S54 (platform)**: the problem+json filter, an injectable clock, configuration schema validation at startup, metrics registry, graceful-shutdown hooks, and the `Idempotency-Key` infrastructure (store, 24 h TTL, in-flight lock).
- **S49 (jobs)**: single-run scheduling for the filter rebuild job.
- **W02 (storefront)**: the share action on the product page and the `ref` cookie (30 days, first party). If W02 does not exist yet, AS-66 stays pending.
- **S10 (cart-checkout) / a future commission capability**: attaching the cookie's `ref` to an order and, later, the commission entry. Neither is specified yet; this capability assumes only that they call `resolveAttributions`. Raised as a `[CONTRACT]` question.
- **Cross-domain data**: none. Share links need no other domain's data, so none of R1 (as a caller), R2 or R3 is used by this capability. Its own stores are the link store, the existence filter, the cache, the counter and the click tables.
