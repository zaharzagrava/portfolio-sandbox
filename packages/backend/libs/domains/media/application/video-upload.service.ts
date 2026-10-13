import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type {
  VideoCompleteRequest,
  VideoCompleteResponse,
  VideoStartRequest,
  VideoStartResponse,
  VideoUploadState,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ProductQueryService } from '@app/domains/catalog';
import { RequestContext } from '@app/infrastructure/context';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import type { StoredPart } from '@app/infrastructure/storage/object-storage.port';
import { sourceKey } from '../domain/delivery-paths';
import {
  partsMismatch,
  pendingUploadsLimit,
  productArchived,
  productNotFound,
  storageUnavailable,
  uploadClosed,
  uploadExpired,
  uploadIncomplete,
  videoNotFound,
} from '../domain/video-errors';
import {
  COMPLETE_POLL_MS,
  COMPLETE_WAIT_MS,
  MAX_PENDING_UPLOADS,
  PART_URL_SECONDS,
  SESSION_HOURS,
  STORAGE_CREATE_TIMEOUT_MS,
  partLengths,
} from '../domain/video-limits';
import {
  VideoMetrics,
  VideoStore,
  type VideoRecord,
} from '../domain/video-ports';
import { VIDEO_PART_SIZE } from '../video.constants';
import {
  ASSEMBLY_FAILED,
  VideoFinalizeService,
  completeAnswer,
} from './video-finalize.service';

const SYSTEM = { type: 'system' } as const;

/** ETags travel quoted from storage and sometimes unquoted from clients: compare the bare value. */
const bare = (etag: string): string => etag.replace(/^"|"$/g, '');

/**
 * Resumable upload straight to storage (S30 R-1–R-5): the API signs, never touches bytes. Start writes the row in one
 * transaction (per-shop advisory lock, quota, history), opens the multipart upload outside any transaction, then signs
 * one permission per part bound to the part number and exact length. `complete` trusts the store's own list of parts,
 * assembles once, checks the size and only then moves the video on; the first message goes out after the commit.
 */
@Injectable()
export class VideoUploadService {
  private readonly logger = new Logger(VideoUploadService.name);

  constructor(
    private readonly store: VideoStore,
    private readonly storage: ObjectStorage,
    private readonly finalizer: VideoFinalizeService,
    private readonly products: ProductQueryService,
    private readonly metrics: VideoMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly context: RequestContext,
    @Inject(VIDEO_PART_SIZE) private readonly partSetting: { value: number },
  ) {}

  // ---- start

  async start(
    shopId: string,
    uploaderId: string,
    body: VideoStartRequest,
  ): Promise<VideoStartResponse> {
    // R1 batch read with the shop predicate, before any transaction (III.3).
    if (body.productId) {
      const product = (
        await this.products.getProductsByIds([body.productId], { shopId })
      ).get(body.productId.toLowerCase());
      if (!product) throw productNotFound();
      if (product.status === 'ARCHIVED') throw productArchived();
    }

    const now = this.clock.now();
    const id = uuidv7();
    const key = sourceKey(id);
    const inserted = await this.store.tx(({ video }) =>
      video.insertUploading({
        id,
        shopId,
        uploaderId,
        title: body.title,
        visibility: body.visibility,
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
        productId: body.productId ?? null,
        shareToken:
          body.visibility === 'unlisted'
            ? randomBytes(32).toString('base64url')
            : null,
        sourceKey: key,
        partSize: this.partSetting.value,
        sessionExpiresAt: new Date(now.getTime() + SESSION_HOURS * 3_600_000),
        now,
      }),
    );
    if (!inserted.ok)
      throw pendingUploadsLimit(MAX_PENDING_UPLOADS, inserted.current);
    const video = inserted.video;
    this.metrics.inc('video_status_transitions_total', {
      from: 'none',
      to: 'UPLOADING',
    });

    // Outside any transaction, with its own time limit (AS-07).
    let uploadId: string;
    try {
      ({ uploadId } = await this.storage.startMultipartUpload(
        key,
        body.contentType,
        { timeoutMs: STORAGE_CREATE_TIMEOUT_MS },
      ));
      if (!(await this.store.video.setUploadId(id, uploadId)))
        throw new Error('the slot was closed while the upload was opened');
    } catch (error) {
      this.logger.warn(
        `could not open a multipart upload: ${(error as Error).message}`,
        undefined,
        { videoId: id },
      );
      await this.store
        .tx(({ video: repo }) => repo.expire(id, SYSTEM, this.clock.now()))
        .catch((e: Error) =>
          this.logger.error(
            `could not expire a half-created video: ${e.message}`,
          ),
        );
      this.metrics.inc('video_status_transitions_total', {
        from: 'UPLOADING',
        to: 'EXPIRED',
      });
      throw storageUnavailable();
    }

    const lengths = partLengths(body.sizeBytes, this.partSetting.value);
    const parts = await this.signParts(video, uploadId, lengths.keys());
    return {
      videoId: id,
      partSize: this.partSetting.value,
      partCount: lengths.length,
      expiresAt: video.sessionExpiresAt.toISOString(),
      visibility: video.visibility,
      shareToken: video.shareToken,
      parts,
    };
  }

  /** One local signature per part; a part's URL names its number and length, valid for an hour (AS-01, AS-08). */
  private signParts(
    video: VideoRecord,
    uploadId: string,
    indexes: Iterable<number>,
  ) {
    const lengths = partLengths(video.sizeBytes, video.partSize);
    return Promise.all(
      [...indexes].map(async (index) => ({
        partNumber: index + 1,
        url: await this.storage.presignUploadPart(
          video.sourceKey,
          uploadId,
          index + 1,
          lengths[index],
          PART_URL_SECONDS,
        ),
        contentLength: lengths[index],
      })),
    );
  }

  // ---- resume

  async resume(shopId: string, id: string): Promise<VideoUploadState> {
    const video = await this.visible(shopId, id);
    // An expired slot is gone for resume (hidden); `complete` tells the seller it expired instead.
    if (video.status === 'EXPIRED') throw videoNotFound();
    if (video.status !== 'UPLOADING') throw uploadClosed(video.status);
    const uploadId = this.openUpload(video);
    const stored = await this.storedParts(video, uploadId);

    const lengths = partLengths(video.sizeBytes, video.partSize);
    const held = new Map(stored.map((p) => [p.partNumber, p.size]));
    // A part with the wrong size counts as missing: its fresh permission overwrites it.
    const complete = (index: number) => held.get(index + 1) === lengths[index];
    const missing = lengths.map((_, i) => i).filter((i) => !complete(i));
    return {
      status: 'UPLOADING',
      partSize: video.partSize,
      partCount: lengths.length,
      uploadedParts: lengths
        .map((_, i) => i)
        .filter(complete)
        .map((i) => ({ partNumber: i + 1, size: lengths[i] })),
      missingParts: missing.map((i) => i + 1),
      parts: await this.signParts(video, uploadId, missing),
      expiresAt: video.sessionExpiresAt.toISOString(),
    };
  }

  // ---- complete

  async complete(
    shopId: string,
    id: string,
    uploaderId: string,
    body: VideoCompleteRequest,
  ): Promise<VideoCompleteResponse> {
    const video = await this.visible(shopId, id);
    const replay = completeAnswer(video);
    if (replay) return replay;

    if (video.status === 'UPLOADING') {
      const uploadId = this.openUpload(video);
      const stored = await this.storedParts(video, uploadId);
      this.assertPartsMatch(video, stored, body);
      const claimed = await this.store.tx(({ video: repo }) =>
        repo.claimUploaded(
          id,
          { type: 'user', id: uploaderId },
          this.clock.now(),
        ),
      );
      if (claimed) {
        this.metrics.inc('video_status_transitions_total', {
          from: 'UPLOADING',
          to: 'UPLOADED',
        });
        return this.finalize(claimed, stored, uploaderId);
      }
    }
    return this.awaitOrDrive(shopId, id, uploaderId);
  }

  /**
   * The loser of a concurrent `complete` (or a retry after a failed assembly) sees `UPLOADED`: it waits for the winner
   * up to 10 s, then drives the idempotent finalize itself (R-5). Answers from the state it finds.
   */
  private async awaitOrDrive(
    shopId: string,
    id: string,
    uploaderId: string,
  ): Promise<VideoCompleteResponse> {
    const steps = Math.ceil(COMPLETE_WAIT_MS / COMPLETE_POLL_MS);
    for (let i = 0; ; i++) {
      const current = await this.visible(shopId, id);
      const answer = completeAnswer(current);
      if (answer) return answer;
      // A marker means an earlier attempt failed half way and nobody is working on it: drive now, do not wait.
      if (current.internalError === ASSEMBLY_FAILED || i >= steps)
        return this.finalize(current, null, uploaderId);
      await sleep(COMPLETE_POLL_MS);
    }
  }

  /** The attributes a message carries so a worker's logs join this request's trace. */
  private trace(): Record<string, string> {
    const traceId = this.context.snapshot().traceparent?.split('-')[1];
    return {
      ...(this.context.requestId && { requestId: this.context.requestId }),
      ...(traceId && { traceId }),
    };
  }

  private finalize(
    video: VideoRecord,
    stored: StoredPart[] | null,
    uploaderId: string,
  ): Promise<VideoCompleteResponse> {
    return this.finalizer.finalize(video, stored, uploaderId, this.trace());
  }

  // ---- shared

  /** The video of this shop, or the one hidden `404` (unknown, other shop, deleted). */
  private async visible(shopId: string, id: string): Promise<VideoRecord> {
    const video = await this.store.video.findInShop(id, shopId);
    if (!video || video.status === 'DELETED') throw videoNotFound();
    return video;
  }

  /** An `UPLOADING` slot whose multipart upload exists and has not run out; otherwise hidden or expired. */
  private openUpload(video: VideoRecord): string {
    if (!video.uploadId) throw videoNotFound(); // the slot is still being created
    if (video.sessionExpiresAt.getTime() <= this.clock.nowMs())
      throw uploadExpired();
    return video.uploadId;
  }

  private async storedParts(
    video: VideoRecord,
    uploadId: string,
  ): Promise<StoredPart[]> {
    try {
      const stored = await this.storage.listParts(video.sourceKey, uploadId, {
        timeoutMs: STORAGE_CREATE_TIMEOUT_MS,
      });
      if (!stored) throw uploadExpired(); // storage no longer knows the upload
      return stored;
    } catch (error) {
      if ((error as { code?: string }).code === 'upload_expired') throw error;
      this.logger.warn(
        `could not list parts: ${(error as Error).message}`,
        undefined,
        { videoId: video.id },
      );
      throw storageUnavailable();
    }
  }

  /** 409 with the missing numbers when storage lacks parts; 422 when the client's list disagrees with storage. */
  private assertPartsMatch(
    video: VideoRecord,
    stored: StoredPart[],
    body: VideoCompleteRequest,
  ): void {
    const lengths = partLengths(video.sizeBytes, video.partSize);
    const held = new Map(stored.map((p) => [p.partNumber, p]));
    const missing = lengths
      .map((len, i) => ({ number: i + 1, len }))
      .filter(({ number, len }) => held.get(number)?.size !== len)
      .map(({ number }) => number);
    if (missing.length > 0) throw uploadIncomplete(missing);

    if (body.parts.length !== lengths.length) throw partsMismatch();
    for (const part of body.parts) {
      const real = held.get(part.partNumber);
      if (!real || bare(real.etag) !== bare(part.etag)) throw partsMismatch();
    }
  }
}
