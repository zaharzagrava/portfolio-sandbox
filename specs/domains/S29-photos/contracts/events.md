# Contract: events of `media` (topic `media.events`, key = `aggregateId`)

Schemas: `packages/contracts/src/media/events.ts` (`mediaEventSchemas`), definitions with `defineEvent` in `libs/domains/media/application/events/media-events.ts`. Envelope for all: `{eventId (uuidv7), type, version: 1, occurredAt, aggregateType: "media", aggregateId}`. Every event is appended with the outbox in the transaction that changed the state (rolled-back transition ⇒ no event). The header comment in today's `media-events.ts` that promises feed/discussion consumers is deleted (E2).

| Event | aggregateId | Payload | Written by | Notes |
|---|---|---|---|---|
| `media.ready` | mediaId | `{mediaId, mediaVersion, shopId: string\|null, uploaderId, purpose, width, height, variants:{thumb,feed,full:{key,width,height}}, duplicateSuspected: boolean}` | processor, READY transaction | **BREAKING**: `possibleDuplicateOf` removed; `mediaVersion` added |
| `media.rejected` | mediaId | `{mediaId, mediaVersion, shopId, uploaderId, purpose, code}` | processor / `complete` (size) / attempt cap | `code` from the closed vocabulary; never a decoder message |
| `media.deleted` | mediaId | `{mediaId, mediaVersion, shopId, purpose}` | `DELETE`, `tenancy.shop_deleted` consumer | consumers drop their references |
| `media.gallery_changed` | productId | `{productId, shopId, mediaIds: string[] (ordered, ≤ 20), galleryVersion}` | gallery replace | empty list when cleared; not written on a no-op `PUT` |
| `media.duplicate_suspected` | mediaId | `{mediaId, shopId, matchedMediaId, matchedShopId, distance}` | processor, READY transaction | moderation only; no consumer in this release |

**Guarantees**: `mediaVersion` strictly increases per photo; no event carries an original key, a decoder message, the perceptual hash or (except `media.ready`/`media.rejected` for the owner's sake) `uploaderId`.

**Consumed** (projector app, `MediaProjectorModule`; idempotency: natural, documented in the module):

| Event | Effect | Invalid payload |
|---|---|---|
| `catalog.product_deleted` v1 `{productId, shopId, productVersion}` | delete `ProductMedia` and `ProductGallery` rows of `productId`; photos stay READY | dead-letter, no side effect |
| `tenancy.shop_deleted` v1 `{shopId}` | every non-`DELETED` photo of the shop → `DELETED` (history, one `media.deleted` each), gallery rows of that shop removed | dead-letter, no side effect |

**Requested of others** (also in `gaps.md`): S32/S26/S43 consume `media.gallery_changed` and resolve images through `getReadyMediaByIds` or `/batch/media`.
