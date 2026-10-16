# Ports and cross-domain calls: S07

Ports live in `domain/ports/` with DI tokens; adapters in `infra/`. `application/` injects tokens only (D-6).

| Port (token) | Methods (summary) | Adapter |
|---|---|---|
| `IMPORT_REPOSITORY` | `insertPending(job, slotRetry)`, `findForShop(id, shopId)`, `findById(id)` (runner/policy), `list(shopId, status?, limit, cursor)`, `transition(...)` (conditional + history + optional event), `claim(id, holder, now)`, `renewLease`, `releaseLease`, `commitBatch(fenced counters + checkpoint [+ terminal])`, `requestCancel(id, shopId, now)`, `listRecoverable(now)`, `markEnqueued(ids, now)`, `listExpirable(now)`, `listPurgeable(now, limit)`, `deleteJobs(ids)`, `deleteShop(shopId)`, `nonFinalByShop(shopId)`, `oldestCheckpointAge(now)` | `SequelizeImportRepository` (raw SQL, own tables only, `TransactionRunner`) |
| `IMPORT_STORAGE` | `startUpload(key)`, `signPart(key, handle, n, len, ttl)`, `listParts(key, handle)`, `completeUpload(...)`, `abortUpload(...)` (unknown = ok), `headSize(key)`, `openSource(key, startByte, signal)`, `putReportPart(key, body)`, `concatReport(prefix, finalKey)`, `signReportDownload(key, name)`, `deleteSource`, `deletePrefix` | `ObjectStorage` adapter; calls `getStream(key,{start})` (new), `put(..., {signal, inactivityTimeoutMs})`, `presignGet(key,{expiresInSec:600, downloadName, contentType:'text/csv; charset=utf-8', userContent:true})` |
| `IMPORT_SCANNER` | the shared `MalwareScanner` (`scan(source,{timeoutMs, inactivityMs?})`, `mode`) | `AntivirusModule` |
| `IMPORT_CATALOG` | `upsert(shopId, items: ExternalProductInput[]): ExternalUpsertResult[]` (1–500; throws `ShopNotActiveError`) | calls `ProductImportService.upsertFromExternal(shopId, items, 'import')`; maps S05 errors |
| `IMPORT_QUEUE` | `enqueue(importId, {delaySeconds?})` | `TaskQueue` wrapper (only `delaySeconds`) |
| `IMPORT_SHOP_ACCESS` | `isMember(shopId, userId, 'products.read')` | `ShopAccessService.assertMember` (throws ⇒ false) |
| `IMPORT_PUBLISHER` | `progress`, `terminal(status…)` | `RealtimePublisher.publish(topic,type,payload,{replay})` |
| `CLOCK` | existing `@app/common/core/clock` | `SystemClock` / frozen in tests |
| random (jitter, holder id) | `Random` function injected | `crypto.randomUUID` / seeded in tests |

**R1 calls used**: `ProductImportService.upsertFromExternal` (catalog), `ShopAccessService.assertMember` (tenancy), `ShopScoped` guard (tenancy), `@User()` (identity). `ProductQueryService.getProductsByIds` in tests only. Nothing else crosses a domain.

**Infrastructure additions (additive, no behavior change for existing callers)**
1. `ObjectStorage.getStream(key, { start?: number })` — ranged read from a byte offset (S3 `Range: bytes=start-`; in-memory slice). A `start` beyond the object ⇒ empty stream; a missing key ⇒ the adapter's not-found error (mapped to `source_missing`).
2. `MalwareScanner.scan(source, { timeoutMs, inactivityMs? })` and `MalwareScanner.mode: 'active' | 'disabled'`; clamd adapter ends on inactivity as well as total deadline and destroys the socket on every exit path.
3. Config rule: scanner mandatory in production for apps that host imports (see research “State of the tree”).
