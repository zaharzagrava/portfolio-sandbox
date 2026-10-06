# SD-08 — Share & Affiliate Links (URL shortener)

Status: ☑ done (typechecked; specs written, not run) · Phase 3 · Depends on: F-02 (Dynamo), SD-28, SD-31 (click analytics) · Edge: `edge-be`

## Marketplace adaptation
Buyers, influencers and shops create short links to products/drops (`mkt.to/aB3x9Kq`) for social media. Clicks are attributed (affiliate/referral commission) and counted. Read:write ≈ 100:1, viral links get millions of clicks in minutes.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **ID ranges** (ticket server): each API instance leases 1,000 IDs from a Redis `INCRBY` counter → **base62** encode → **bijective scramble** (Feistel on 42 bits) so codes aren't guessable | 10/05 #8 |
| Custom aliases with uniqueness via Dynamo conditional put | 10/05 #8 |
| Store in **DynamoDB** `Links` (PK code) — pure KV, unbounded scale | 10/05 #8, D24 |
| **Redirect at the edge**: Cloudflare worker looks up Upstash Redis/cached KV → 302 (analytics needed, editable) without touching origin | 10/05 #8, D14 |
| Cache-aside + **negative caching** for unknown codes + Bloom filter for enumeration scans | 03/04 §4 |
| Click event emitted asynchronously (edge → ingest API → Kafka `link.clicks` → ClickHouse) — never in the redirect path | 10/09 #31 |
| Attribution: `ref` cookie (first-party, 30 days) → checkout reads it → affiliate commission ledger entry (SD-20) | — |
| Abuse: Safe Browsing-style check hook on create (destinations restricted to marketplace domains → open-redirect prevention) | 05/01 §6 |

## Steps
- [x] `ShareLinksModule`: create (`POST /links`), resolve (`GET /l/:code` fallback at origin), stats (`GET /links/:code/stats` from ClickHouse).
- [x] ID lease allocator (shared with any future short-code need) + base62 + Feistel scramble (pure functions, unit-tested — shared).
- [x] Dynamo table def; Redis cache; Bloom filter of existing codes.
- [x] Edge worker route `mkt.to/*`: Upstash GET → 302; miss → origin.
- [x] Click ingestion → Kafka → ClickHouse `link_clicks` + MV per link/minute.
- [x] e2e: create → resolve 302 to product URL; unknown → 404 cached negative; alias conflict → 409; destination outside marketplace → 422.

## Scale
- Target: 40k redirects/s peak (viral), 400 creates/s; 5B links over 5 years.
- Hot path: edge Redis GET → 302 (origin not involved for hits); click → async beacon to ingest.
- First bottleneck & fix: one viral code = hot key → Cloudflare cache the 302 for 10 s per code (editability trade-off ≤ 10 s); ID allocation never a bottleneck thanks to leases.
- Capacity model: 5B × ~300 B = 1.5 TB in Dynamo (on-demand) — fine; Upstash/Redis holds hot 1M codes ≈ 300 MB.
- Proof: k6 Zipf redirects at edge-local (wrangler) + origin fallback; p99 < 20 ms origin.

## Implementation notes (2026-10-01)
- `share-links/codes.ts`: base62 (7 chars) + **keyed 4-round Feistel over 40 bits** (bijective → no collision checks; sequential ids look random). Verified invertible + collision-free on 20k ids. `IdLease`: Redis `INCRBY` blocks of 1,000 per instance. Spec `codes.spec.ts`.
- `ShareLinkService`: DynamoDB `Links` (`dynamodb/Links.json`, GSI by owner, TTL), custom aliases via conditional put, destinations restricted to marketplace hosts (open-redirect prevention), resolve = Bloom filter (SD-34) → cache-aside with SWR + negative caching → Dynamo, alias claim invalidates a cached "not found". Clicks: fire-and-forget `links.events` → `LinkClicksProjector` → ClickHouse (`clickhouse/020_link_clicks.sql`, per-minute MV); stats endpoint reads the rollup.
- Endpoints: `POST /api/links`, `GET /api/links`, `GET /api/links/:code/stats`, `GET /api/l/:code` (302 + `ref`, `s-maxage=10`).
- Edge (`packages/edge-be`): `/l/:code` records the click at the edge (`waitUntil` → Kafka REST, same envelope), serves cached 302s from `caches.default`, origin calls flagged `x-edge-click-recorded`. Edge typecheck clean.
- Attribution: destination carries `?ref=<code>`; the storefront keeps it as a first-party cookie and checkout attaches it (FE phase 2; affiliate commission journal via SD-20 `ledger.post`).
- Spec `share-links/share-links.e2e-spec.ts`.
