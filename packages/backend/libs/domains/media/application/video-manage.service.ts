import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  VideoCompleteResponse,
  VideoList,
  VideoListQuery,
  VideoOwner,
  VideoPatchRequest,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ProductQueryService } from '@app/domains/catalog';
import { RequestContext } from '@app/infrastructure/context';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import {
  invalidCursor,
  invalidState,
  notRetryable,
  productArchived,
  productNotFound,
  productVideoLimit,
  retryLimit,
  sourcePurged,
  uploadExpired,
  validationFailed,
  versionConflict,
  videoNotFound,
} from '../domain/video-errors';
import {
  VideoMetrics,
  VideoStore,
  type VideoRecord,
} from '../domain/video-ports';
import { VIDEO_ORIGIN, VIDEO_QUEUE } from '../video.constants';
import { messageAttributes } from './video-messages';
import { toOwnerView } from './video-view';

interface CursorPayload {
  /** createdAt (ISO), id, shop, filter: a cursor is valid only for the list it came from. */
  c: string;
  i: string;
  s: string;
  f: string;
}

const encodeCursor = (p: CursorPayload): string =>
  Buffer.from(JSON.stringify(p)).toString('base64url');

/**
 * Seller management of videos (S30 R-16): read, keyset list, optimistic edit and product link, retry, delete. Every
 * lookup carries the shop (III.4); a video of another shop, an unknown id and a deleted one are the same `404`.
 * Storage and queue calls happen after the transaction, never inside it.
 */
@Injectable()
export class VideoManageService {
  private readonly logger = new Logger(VideoManageService.name);

  constructor(
    private readonly store: VideoStore,
    private readonly storage: ObjectStorage,
    private readonly queue: TaskQueue,
    private readonly products: ProductQueryService,
    private readonly metrics: VideoMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly context: RequestContext,
    @Inject(VIDEO_ORIGIN) private readonly origin: string,
  ) {}

  // ---- read

  async read(shopId: string, id: string): Promise<VideoOwner> {
    const video = await this.store.video.findInShop(id, shopId);
    if (!video || video.status === 'DELETED') throw videoNotFound();
    return this.view(video);
  }

  private async view(video: VideoRecord): Promise<VideoOwner> {
    return toOwnerView(
      video,
      await this.store.tasks.progress(video.id),
      this.origin,
    );
  }

  async list(shopId: string, query: VideoListQuery): Promise<VideoList> {
    const filter = query.status ?? '';
    let after: { createdAt: Date; id: string } | null = null;
    if (query.cursor) {
      let payload: CursorPayload;
      try {
        payload = JSON.parse(
          Buffer.from(query.cursor, 'base64url').toString('utf8'),
        );
      } catch {
        throw invalidCursor();
      }
      const createdAt = new Date(payload?.c);
      if (
        !payload ||
        payload.s !== shopId ||
        payload.f !== filter ||
        typeof payload.i !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(payload.i) ||
        Number.isNaN(createdAt.getTime())
      )
        throw invalidCursor();
      after = { createdAt, id: payload.i };
    }
    const rows = await this.store.video.list({
      shopId,
      limit: query.limit + 1,
      status: query.status ?? null,
      after,
    });
    const page = rows.slice(0, query.limit);
    const progress = await this.store.tasks.progressMany(page.map((v) => v.id));
    const last = page[page.length - 1];
    return {
      items: page.map((v) => toOwnerView(v, progress.get(v.id)!, this.origin)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({
              c: last.createdAt.toISOString(),
              i: last.id,
              s: shopId,
              f: filter,
            })
          : null,
    };
  }

  // ---- edit and link

  async patch(
    shopId: string,
    id: string,
    body: VideoPatchRequest,
  ): Promise<VideoOwner> {
    if (body.title === undefined && body.productId === undefined)
      throw validationFailed(['title', 'productId']);
    // R1 batch read with the shop predicate, before the transaction (III.3).
    if (body.productId) {
      const product = (
        await this.products.getProductsByIds([body.productId], { shopId })
      ).get(body.productId.toLowerCase());
      if (!product) throw productNotFound();
      if (product.status === 'ARCHIVED') throw productArchived();
    }
    const result = await this.store.tx(({ video }) =>
      video.patch({
        id,
        shopId,
        expectedVersion: body.expectedVersion,
        title: body.title,
        productId: body.productId,
        now: this.clock.now(),
      }),
    );
    if (result.ok) return this.view(result.video);
    switch (result.reason) {
      case 'version_conflict':
        throw versionConflict(result.currentVersion!);
      case 'product_video_limit':
        throw productVideoLimit();
      case 'upload_expired':
        throw uploadExpired();
      default:
        throw videoNotFound();
    }
  }

  // ---- retry

  async retry(
    shopId: string,
    id: string,
    actorId: string,
  ): Promise<VideoCompleteResponse> {
    const result = await this.store.tx(({ video }) =>
      video.retry({
        id,
        shopId,
        actor: { type: 'user', id: actorId },
        now: this.clock.now(),
      }),
    );
    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          throw videoNotFound();
        case 'invalid_state':
          throw invalidState(result.status ?? 'unknown');
        case 'not_retryable':
          throw notRetryable();
        case 'retry_limit':
          throw retryLimit();
        default:
          throw sourcePurged();
      }
    }
    this.metrics.inc('video_status_transitions_total', {
      from: 'FAILED',
      to: 'PROCESSING',
    });
    // After the commit; a message lost here is found again by the sweep (the tasks stay `QUEUED`).
    const traceId = this.context.snapshot().traceparent?.split('-')[1];
    for (const task of result.ready)
      await this.queue
        .enqueue(
          VIDEO_QUEUE,
          { videoId: id, task },
          {
            attributes: messageAttributes(this.clock, {
              ...(traceId && { traceId }),
              ...(this.context.requestId && {
                requestId: this.context.requestId,
              }),
            }),
          },
        )
        .catch((e: Error) =>
          this.logger.error(
            `could not enqueue ${task} of a retried video; the sweep will: ${e.message}`,
          ),
        );
    return { status: 'PROCESSING' };
  }

  // ---- delete

  async remove(shopId: string, id: string, actorId: string): Promise<void> {
    const deleted = await this.store.tx(({ video }) =>
      video.softDelete({
        id,
        shopId,
        actor: { type: 'user', id: actorId },
        now: this.clock.now(),
      }),
    );
    if (!deleted) throw videoNotFound();
    this.metrics.inc('video_status_transitions_total', {
      from: deleted.previous,
      to: 'DELETED',
    });
    // Objects are removed by the purge job. Only an open multipart upload is aborted here, after the commit.
    if (deleted.previous === 'UPLOADING' && deleted.video.uploadId)
      await this.storage
        .abortMultipartUpload(deleted.video.sourceKey, deleted.video.uploadId, {
          timeoutMs: 5_000,
        })
        .catch((e: Error) =>
          this.logger.warn(`could not abort a multipart upload: ${e.message}`),
        );
  }
}
