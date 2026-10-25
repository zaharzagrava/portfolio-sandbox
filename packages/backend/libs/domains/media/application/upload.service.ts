import { Inject, Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type {
  MediaCompleteResponse,
  MediaUploadResponse,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { RequestContext } from '@app/infrastructure/context';
import { ShopAccessService } from '@app/domains/tenancy';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import {
  mediaNotFound,
  pendingUploadsLimit,
  uploadExpired,
  uploadIncomplete,
} from '../domain/media-errors';
import { MediaStore } from '../domain/ports';
import type { MediaRecord } from '../domain/ports';
import {
  ALLOWED_CONTENT_TYPES,
  MAX_ORIGINAL_BYTES,
  MAX_PENDING_UPLOADS,
  originalKeyFor,
  SIGNATURE_SECONDS,
} from '../domain/upload-policy';
import { MEDIA_QUEUE } from '../media.constants';

/**
 * The API never touches image bytes (10/05 #10): it creates the record (with its first history row, one transaction,
 * no storage or queue call inside), hands out a presigned POST whose policy binds the server-chosen key, the content
 * types and the size, and, on `complete`, checks that the object arrived and tells the worker (S29 FR-001–FR-009).
 */
@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(
    private readonly store: MediaStore,
    private readonly storage: ObjectStorage,
    private readonly queue: TaskQueue,
    private readonly access: ShopAccessService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly context: RequestContext,
  ) {}

  async presign(
    uploaderId: string,
    purpose: 'product' | 'review',
    shopId: string | null,
  ): Promise<MediaUploadResponse> {
    // The client never chooses (or overwrites) a path.
    const originalKey = originalKeyFor(
      shopId ? { shopId } : { userId: uploaderId },
      uuidv4(),
    );
    const now = this.clock.now();
    const reserved = await this.store.tx(({ media: repo }) =>
      repo.reservePending({
        shopId,
        uploaderId,
        purpose,
        originalKey,
        now,
        limit: MAX_PENDING_UPLOADS,
      }),
    );
    if (!reserved.ok) throw pendingUploadsLimit(reserved.current);
    const media = reserved.media;
    // Signing is a local computation: nothing in the transaction above waited for storage.
    const signed = await this.storage.presignPost({
      key: originalKey,
      contentTypes: [...ALLOWED_CONTENT_TYPES],
      minBytes: 1,
      maxBytes: MAX_ORIGINAL_BYTES,
      expiresInSec: SIGNATURE_SECONDS,
    });
    return {
      mediaId: media.id,
      upload: {
        url: signed.url,
        fields: signed.fields,
        expiresAt: new Date(
          now.getTime() + SIGNATURE_SECONDS * 1000,
        ).toISOString(),
      },
      maxBytes: MAX_ORIGINAL_BYTES,
      allowedContentTypes: [
        ...ALLOWED_CONTENT_TYPES,
      ] as MediaUploadResponse['allowedContentTypes'],
    };
  }

  async complete(
    userId: string,
    mediaId: string,
  ): Promise<MediaCompleteResponse> {
    const media = await this.store.media.findForUploader(mediaId, userId);
    if (!media) throw mediaNotFound();
    await this.assertStillAllowed(media, userId);

    const answered = this.answerFromState(media);
    if (answered) return answered;

    // Outside any transaction: storage may be slow.
    const head = await this.storage.head(media.originalKey);
    if (!head) throw uploadIncomplete();
    const now = this.clock.now();
    if (head.size < 1 || head.size > MAX_ORIGINAL_BYTES) {
      const rejected = await this.store.tx(({ media: repo }) =>
        repo.markRejected({
          id: media.id,
          from: ['PENDING_UPLOAD'],
          code: 'size_invalid',
          actor: { type: 'user', id: userId },
          now,
        }),
      );
      if (rejected) {
        await this.storage
          .delete(media.originalKey)
          .catch((error: Error) =>
            this.logger.warn(
              `could not delete an oversize original: ${error.message}`,
            ),
          );
        return { status: 'REJECTED', rejectCode: 'size_invalid' };
      }
      return this.replay(media.id, userId);
    }

    const uploaded = await this.store.tx(({ media: repo }) =>
      repo.markUploaded(media.id, { type: 'user', id: userId }, now),
    );
    // Lost the race (a concurrent complete, or the worker already took it): answer from state, send nothing.
    if (!uploaded) return this.replay(media.id, userId);

    await this.enqueue(uploaded);
    return { status: 'UPLOADED' };
  }

  /** After commit: a lost message is recovered by `media.requeue-stuck`, so a failure here is counted and logged only. */
  private async enqueue(media: MediaRecord): Promise<void> {
    const traceparent = this.context.snapshot().traceparent;
    const traceId = traceparent?.split('-')[1];
    try {
      await this.queue.enqueue(
        MEDIA_QUEUE,
        { mediaId: media.id, originalKey: media.originalKey },
        {
          attributes: {
            ...(this.context.requestId && {
              requestId: this.context.requestId,
            }),
            ...(traceId && { traceId }),
          },
        },
      );
    } catch (error) {
      this.logger.error(
        `could not enqueue a confirmed upload; the re-drive job will: ${(error as Error).message}`,
        undefined,
        { mediaId: media.id },
      );
    }
  }

  private answerFromState(media: MediaRecord): MediaCompleteResponse | null {
    switch (media.status) {
      case 'PENDING_UPLOAD':
        return null;
      case 'UPLOADED':
        return { status: 'UPLOADED' };
      case 'PROCESSING':
        return { status: 'PROCESSING' };
      case 'READY':
        return { status: 'READY' };
      case 'REJECTED':
        return {
          status: 'REJECTED',
          ...(media.rejectCode && { rejectCode: media.rejectCode }),
        };
      case 'EXPIRED':
        throw uploadExpired();
      default:
        throw mediaNotFound();
    }
  }

  private async replay(
    mediaId: string,
    userId: string,
  ): Promise<MediaCompleteResponse> {
    const current = await this.store.media.findForUploader(mediaId, userId);
    if (!current) throw mediaNotFound();
    return this.answerFromState(current) ?? { status: 'UPLOADED' };
  }

  /** A shop photo is completed only while its uploader still holds `products.write` in that shop. */
  private async assertStillAllowed(
    media: MediaRecord,
    userId: string,
  ): Promise<void> {
    if (!media.shopId) return;
    try {
      await this.access.assertMember(media.shopId, userId, 'products.write');
    } catch (error) {
      // Not a member any more: the photo is no longer theirs to touch, and its existence stays hidden.
      if ((error as { code?: string }).code === 'shop_not_found')
        throw mediaNotFound();
      throw error;
    }
  }
}
