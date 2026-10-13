# Contract: events of video (`media` domain, topic `media.events`, key = `aggregateId` = `videoId`)

Schemas: `packages/contracts/src/media/video-events.ts` (`videoEventSchemas`), definitions with `defineEvent` in `libs/domains/media/domain/video-events.ts`. Envelope for all: `{eventId, type, version: 1, occurredAt, aggregateType: "video", aggregateId}` (the repo's strict envelope; the spec's five-field list is a subset). Every event is appended with `OutboxService.append` in the transaction that changed the state: a rolled-back transition leaves neither state change nor event (AS-56, forced by a trigger on the outbox insert). Names are in a separate space from the photo `media.ready`.

| Event | aggregateId | Payload | Written by |
|---|---|---|---|
| `video.ready` | videoId | `{videoId, videoVersion, shopId, uploaderId, productId: string\|null, visibility, durationSec, width, height, renditions:[{name,width,height}], hasSprite: boolean}` | `publish` transaction |
| `video.failed` | videoId | `{videoId, videoVersion, shopId, uploaderId, failureCode}` | the transaction that moves to `FAILED` (probe rejection, retries exhausted, timeout, size mismatch, `processing_timeout`) |
| `video.deleted` | videoId | `{videoId, videoVersion, shopId, productId: string\|null}` | seller delete, `tenancy.shop_deleted` consumer (one per video) |

**Guarantees**: `videoVersion` is the row's version after the change and strictly increases per video; no payload contains a storage location, URL, share token, credential or upload id (scanned in AS-56); no event is written for field edits, product-link changes or retries.

**Consumers (told to the owners, not edited here)**: S28 may tell the uploader on `video.ready`/`video.failed`; S32 may set a "product has video" flag from `video.ready`/`video.deleted` (`productId`); consumers fetch playback through the HTTP routes.

**Consumed** (projector app, `VideoProjectorModule`; no storage or queue module is imported):

| Event | Effect | Idempotency | Invalid payload |
|---|---|---|---|
| `catalog.product_deleted` v1 `{productId, shopId, productVersion}` | `productId = NULL`, `version + 1` on the videos of that shop linked to the product | natural (second delivery finds none) | dead-letter, no effect; `shopId` that does not match the row changes nothing |
| `tenancy.shop_deleted` v1 `{shopId}` | the shop's non-`DELETED` videos → `DELETED` in batches of 50 (history, `video.deleted`, open tasks `CANCELLED`) | natural | dead-letter |
| `tenancy.shop_status_changed` v1 `{shopId, from, to, reason?, shopVersion}` | upsert `VideoShopState {suspended: to='SUSPENDED', shopVersion}` only when `shopVersion` is higher | version guard | dead-letter |

**Queue (not an event)**: `video-transcode` carries `{videoId, task}` with the message attribute `traceId`; consumed only by `VideoWorkerModule`; a body that fails its schema goes to `video-transcode-dlq` at once.
