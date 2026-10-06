# SD-06 — Offline-First Inventory Sync (pop-up store / warehouse app backend)

Status: ☑ done (backend half; typechecked; specs written, not run) · Phase 5 · Depends on: SD-02, SD-19 · FE (PWA, IndexedDB, Service Worker) = phase 2

## Marketplace adaptation
Shop staff at pop-up stores and warehouses count stock, receive deliveries and sell in-person **with poor connectivity**. Their app works offline and syncs later; several devices may edit the same SKU.

## Patterns showcased (backend half)
| Pattern | Lesson |
|---|---|
| **Push**: batch of client operations `{opId (UUIDv7, client-generated), entity, op, payload, baseVersion}` — idempotent by opId | 10/04 #6 |
| **Pull**: "changes since cursor" from a per-shop **change log with monotonic sequence** (not timestamps) | 10/04 #6 |
| Conflict resolution per data type: stock counts as **commutative deltas** (CRDT-like PN-counter: "+5 received", "−1 sold" merge without conflicts); product fields **LWW per field** with server versions; conflicting non-mergeable edits → conflict list for review | 10/04 #6, 06/02 §3.3 |
| Hybrid logical clocks for ordering client ops without trusting device clocks | 06/02 §6 |
| Auth while offline: ops queued, pushed after re-auth; ops signed with device id | 10/04 #6 |

## Steps
- [x] `SyncOperation` (opId PK), `ShopChangeLog` (shopId, seq) models.
- [x] `POST /sync/push`, `GET /sync/pull?cursor=`.
- [x] Merge engine (pure, unit-tested) for counters + LWW fields.
- [x] e2e: two devices push +3 and −1 for the same SKU offline → final = base + 2; same push replayed → no double apply.

## Scale
- Target: 200k devices, sync bursts at store opening 10k RPS.
- Hot path: push = batched insert of ops (idempotent) + delta apply; pull = range scan on `(shopId, seq)` index (or Redis stream tail for recent).
- Proof: k6 sync burst; p99 < 200 ms.

## Implementation notes (2026-10-01)
- **Migration `20261001360000-offline-sync`:**
  - `SyncOperation` (client opId PK → replay-safe).
  - `ShopChangeLog`, fed by an AFTER INSERT/UPDATE trigger on `Product` using a per-shop gap-free seq (`ShopSyncState` row lock). Changes from orders, the API and the dashboard reach devices too.
  - `ProductFieldClock` for per-field LWW.
- **Merge rules:** `hlc.ts` (hybrid logical clock, string-ordered, with a drift cap) and `merge.ts` (stock ops are commutative deltas, a count becomes `counted − base`; product fields are LWW per field). Unit spec `merge.spec.ts`.
- **`SyncService`:**
  - One transaction per op: claim the opId → apply → record the result (`applied` / `merged` / `duplicate` / `conflict` / `rejected`).
  - Negative stock is applied but flagged as a conflict (oversold). Ops with future clocks are rejected.
  - Pull = change log after the cursor.
- **Endpoints:** `POST /api/shops/:shopId/sync/push` (X-Device-Id, ≤ 500 zod-validated ops), `GET /sync/pull?cursor=`, `GET /sync/conflicts`.
- **Spec** `offline-sync/sync.e2e-spec.ts`.
