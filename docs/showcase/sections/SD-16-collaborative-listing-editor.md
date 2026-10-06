# SD-16 — Collaborative Product Listing Editor (Google Docs-lite for shop teams)

Status: ☑ done (typechecked; specs written, not run) · Phase 4 · Depends on: SD-02, SD-39, F-02 (S3) · DOUBTS Q7

## Marketplace adaptation
A shop's team co-edits a **product listing draft** (title, rich description, spec table) before publishing. Several staff type at once; presence cursors; version history; publish creates the product revision.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **CRDT (Yjs)** document per draft; server = Nest WebSocket gateway speaking the y-websocket protocol (`y-protocols` sync + awareness) | 10/06 #16 |
| **Room routing with consistent hashing** (hash ring with virtual nodes over collab instances, registry in Redis) so all editors of a draft reach the same in-memory room; ring rebalancing moves ~1/N rooms on scale-out (genuinely needed) | 10/06 #16, 10/09 #34 |
| Persistence: append Yjs updates to an **update log** (DynamoDB `DocUpdates`, PK docId, SK seq) + periodic **snapshot compaction** to S3 → load = snapshot + tail | 10/06 #16 |
| Awareness (cursors/selection) ephemeral, never persisted | 10/06 #16 |
| Permissions on join **and** per update (viewer can't write); revoke → kick | 10/06 #16 |
| Version history = named snapshots; publish = snapshot → product revision via outbox | 10/06 #16 |
| Offline resume: state-vector exchange sends only missing updates | 10/06 #16 |

## Steps
- [x] Deps: `yjs`, `y-protocols`, `lib0`, `@nestjs/websockets`, `@nestjs/platform-ws`.
- [x] `apps/collab/` — WS gateway, room manager, consistent-hash ring (pure, unit-tested), redirect hint when a client lands on the wrong instance.
- [x] Persistence adapter (Dynamo log + S3 snapshots + compaction job).
- [x] `POST /drafts`, `POST /drafts/:id/publish`, `GET /drafts/:id/versions`.
- [x] e2e: two Yjs docs connected through the gateway converge after concurrent inserts; viewer update rejected; reload = snapshot + tail equals live state.

## Scale
- Target: 100k concurrently open drafts, ≤ 50 editors per draft, 20k updates/s.
- Hot path: in-memory Y.Doc per room; updates appended to Dynamo asynchronously in micro-batches (100 ms).
- First bottleneck & fix: room memory/CPU on one instance → ring with virtual nodes balances rooms; instance loss → clients reconnect, room reloads from snapshot+tail.
- Capacity: ~5k rooms per instance → 20 instances.
- Proof: k6 WS scenario (editors typing) — convergence + p99 update broadcast < 100 ms.

## FE visualisation (phase 2)
TipTap/ProseMirror editor bound to Yjs with live cursors.

## Implementation notes (2026-10-01)
- **New deployable `apps/collab`** (`nest start collab`): raw `ws` on Nest's HTTP server, not `@nestjs/websockets`, because y-websocket is binary frames. Deps: yjs, y-protocols, lib0, ws.
- **Routing:**
  - `HashRing` uses md5 with 256 virtual nodes; the unit spec shows balance within 15% and that adding a node moves ~1/N of the keys, all to the new node.
  - `CollabInstanceRegistry` keeps a Redis ZSET heartbeat; core and collab build identical rings.
  - The handshake checks ownership; the wrong instance closes with `4001 <owner url>`.
- **`Room`** (one Y.Doc per draft):
  - Speaks the y-websocket sync/awareness protocol. Permissions are checked per message (a viewer may send step 1; step 2/update from a viewer is dropped).
  - Broadcasts immediately; persistence is one `Y.mergeUpdates` per 100 ms, written as a conditional DynamoDB put (`DocUpdates`, a split-brain guard). A seq conflict marks the room failed and closes its sockets with 4002 so clients reconnect to the owner.
  - Compacts to S3 every 200 flushes and on unload. Awareness is never persisted.
- **`RoomManager`:** single-flight load (snapshot + tail), unload after 30 s idle, revocation through Redis pub/sub (`kick` → 4003).
- **`DraftStore`:**
  - `load` = S3 snapshot + Dynamo tail (works in any process).
  - `append` is conditional.
  - `compact` = snapshot, then move the Postgres pointer forward-only, then batch-delete the trimmed log.
  - `seed` = start a draft from an existing product.
- **Core `DraftsModule`:**
  - `POST /api/shops/:shopId/drafts`.
  - `POST .../drafts/:id/connect` → `{url, ticket, canWrite}`. The ticket is a 60 s JWT bound to the draft and permission; members are BOLA-safe (404); viewers and published drafts get read-only.
  - Versions (named S3 snapshots).
  - `publish`: CRDT → create the product via `ProductService`, or update it with a version bump + `products.events` outbox in one transaction; then freeze a "Published" version.
- **Document schema** (`listing-doc.ts`): Y.Text `title` and `description`, Y.Map `fields` (price, brand, category, quantity) and `specs`.
- **Specs:** `collab/hash-ring.spec.ts` and `collab/collab.e2e-spec.ts` (real WebSockets: two editors converge with concurrent edits, persisted state = live; viewer writes dropped; ticket/permission handshake; publish → product + version).
