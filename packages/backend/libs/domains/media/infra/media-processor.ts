import { bands, CANDIDATE_CAP, findNearest } from '../domain/duplicate-match';
import type {
  Blobs,
  Actor,
  MalwareScannerPort,
  MediaLogger,
  MediaLogFields,
  MediaMetrics,
  MediaRecord,
  ReadyInput,
  Tx,
} from '../domain/ports';
import { noopLogger, noopMetrics } from '../domain/ports';
import {
  RejectedImageError,
  RejectCode,
  TransientProcessingError,
} from '../domain/reject-code';
import {
  DERIVED_PREFIX,
  MAX_ATTEMPTS,
  MAX_ORIGINAL_BYTES,
} from '../domain/upload-policy';
import type { Variants } from '../domain/media-urls';
import { processImage } from './image-pipeline';

export type ProcessResult = 'READY' | 'REJECTED' | 'SKIPPED' | 'BUSY';

export interface ProcessorLimits {
  readMs: number;
  writeMs: number;
  scanMs: number;
  runMs: number;
}
/** FR-020: read 20 s, each variant write 10 s, scanner 15 s, one image's whole run 45 s. */
export const DEFAULT_LIMITS: ProcessorLimits = {
  readMs: 20_000,
  writeMs: 10_000,
  scanMs: 15_000,
  runMs: 45_000,
};

export interface MediaProcessorDeps {
  /** One database transaction with repositories bound to it; supplied by the caller (Nest, or `pg` in the Lambda). */
  tx: Tx;
  blobs: Blobs;
  scanner: MalwareScannerPort;
  clock: { now(): Date };
  metrics?: MediaMetrics;
  logger?: MediaLogger;
  limits?: Partial<ProcessorLimits>;
}

export interface ProcessContext {
  requestId?: string;
  traceId?: string;
}

const WORKER: Actor = { type: 'worker' };
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * The worker core, framework-free (it runs in a small Lambda: sharp + pg + S3 SDK, no Nest container):
 *   originalKey → claim (lease, attempt count) → malware scan → header and limit checks → three content-addressed
 *   variants → existence check → ONE transaction (band locks, nearest-match scan, `→ READY`, history, outbox events).
 * Re-running for the same key is harmless: variant keys are content hashes and every transition is conditional.
 * A permanent refusal ends `REJECTED` with a code of the closed vocabulary; anything else ends the run with a
 * `TransientProcessingError` (the message is not acknowledged and the queue retries; only the claim counts attempts).
 */
export function createMediaProcessor(deps: MediaProcessorDeps): {
  process(
    originalKey: string,
    context?: ProcessContext,
  ): Promise<ProcessResult>;
} {
  const metrics = deps.metrics ?? noopMetrics;
  const logger = deps.logger ?? noopLogger;
  const limits: ProcessorLimits = { ...DEFAULT_LIMITS, ...deps.limits };

  async function reject(
    media: MediaRecord,
    code: RejectCode,
    from: MediaRecord['status'],
  ): Promise<void> {
    const now = deps.clock.now();
    await deps.tx(({ media: repo }) =>
      repo.markRejected({
        id: media.id,
        from: [from],
        code,
        actor: WORKER,
        now,
      }),
    );
  }

  return {
    async process(originalKey, context = {}): Promise<ProcessResult> {
      const started = deps.clock.now();
      const deadline = started.getTime() + limits.runMs;
      const left = (cap: number): number => {
        const remaining = deadline - deps.clock.now().getTime();
        if (remaining <= 0)
          throw new TransientProcessingError('run budget exceeded');
        return Math.min(cap, remaining);
      };
      const fields = (
        media: MediaRecord | null,
        extra: MediaLogFields = {},
      ): MediaLogFields => ({
        ...(media && { mediaId: media.id, attempt: media.attempts }),
        ...context,
        ...extra,
      });
      const finish = (result: string, media: MediaRecord | null): void => {
        metrics.inc('media_processing_total', { result });
        const durationMs = deps.clock.now().getTime() - started.getTime();
        metrics.observe('media_processing_seconds', durationMs / 1000, {
          result,
        });
        logger.info('media processed', fields(media, { result, durationMs }));
      };

      const claim = await deps.tx(({ media: repo }) =>
        repo.claim(originalKey, deps.clock.now()),
      );
      if (claim.outcome === 'skipped') {
        if (claim.reason === 'unknown') {
          metrics.inc('media_unknown_key_total');
          logger.warn('media key unknown', fields(null, { result: 'skipped' }));
        }
        metrics.inc('media_processing_total', { result: 'skipped' });
        return 'SKIPPED';
      }
      if (claim.outcome === 'busy') {
        metrics.inc('media_processing_total', { result: 'busy' });
        return 'BUSY';
      }
      const media = claim.media;

      // FR-019 / AS-22: the fifth claim is not processed, it rejects (so a poison file costs four attempts, not a loop).
      if (media.attempts >= MAX_ATTEMPTS) {
        await reject(media, 'processing_failed', 'PROCESSING');
        metrics.inc('media_processing_attempts_exhausted_total');
        logger.error(
          'media attempts exhausted',
          fields(media, { result: 'rejected' }),
        );
        finish('rejected', media);
        return 'REJECTED';
      }

      try {
        // 1. The original must be a plausible size before anything reads it.
        const head = await deps.blobs.head(originalKey, left(limits.readMs));
        if (!head || head.size < 1 || head.size > MAX_ORIGINAL_BYTES) {
          if (!head)
            throw new TransientProcessingError('original not readable yet');
          await deps.blobs.delete(originalKey).catch(() => undefined);
          await reject(media, 'size_invalid', 'PROCESSING');
          finish('rejected', media);
          return 'REJECTED';
        }

        // 2. Malware scan, before any variant exists. An engine that cannot answer is a transient failure.
        let verdict;
        try {
          verdict = await deps.scanner.scan(
            await deps.blobs.stream(originalKey, left(limits.readMs)),
            { timeoutMs: left(limits.scanMs) },
          );
        } catch (error) {
          if (error instanceof TransientProcessingError) throw error;
          metrics.inc('media_scan_unavailable_total');
          throw new TransientProcessingError(
            'malware scanner unavailable',
            error,
          );
        }
        if (!verdict.clean) {
          await deps.blobs.delete(originalKey).catch(() => undefined);
          await reject(media, 'malware_detected', 'PROCESSING');
          finish('rejected', media);
          return 'REJECTED';
        }

        // 3. Decide from the bytes, then make the variants.
        const bytes = await deps.blobs.read(originalKey, left(limits.readMs));
        const processed = await processImage(bytes, {
          computeHash: media.purpose === 'product',
        });
        const variants = {} as Variants;
        for (const [name, v] of Object.entries(processed.variants) as [
          keyof Variants,
          (typeof processed.variants)['thumb'],
        ][]) {
          const key = `${DERIVED_PREFIX}${v.hash}.webp`;
          await deps.blobs.write(key, v.buffer, v.contentType, {
            cacheControl: IMMUTABLE,
            timeoutMs: left(limits.writeMs),
          });
          variants[name] = { key, width: v.width, height: v.height };
        }
        // READY only after all three objects are confirmed to exist (AS-24).
        for (const v of Object.values(variants)) {
          const present = await deps.blobs.head(v.key, left(limits.readMs));
          if (!present || present.size < 1)
            throw new TransientProcessingError(
              'variant object missing after write',
            );
        }

        // 4. One transaction: no storage or queue call inside it.
        let truncated = 0;
        let flagged = false;
        const ready = await deps.tx(async ({ media: repo }) => {
          const now = deps.clock.now();
          let duplicate: ReadyInput['duplicate'] = null;
          let hash: ReadyInput['hash'] = null;
          if (processed.dhash && media.shopId) {
            const hashBands = bands(processed.dhash);
            hash = { dhash: processed.dhash, bands: hashBands };
            await repo.lockBands(hashBands);
            const scan = await repo.scanDuplicates(
              hashBands,
              media.shopId,
              CANDIDATE_CAP,
            );
            truncated = scan.truncatedBands;
            const nearest = findNearest(processed.dhash, scan.candidates);
            if (nearest) {
              const match = scan.candidates.find((c) => c.id === nearest.id)!;
              duplicate = {
                mediaId: nearest.id,
                shopId: match.shopId,
                distance: nearest.distance,
              };
            }
          }
          const row = await repo.markReady(
            {
              id: media.id,
              variants,
              width: processed.width,
              height: processed.height,
              hash,
              duplicate,
              uploadedToReadyMs: media.uploadedAt
                ? now.getTime() - media.uploadedAt.getTime()
                : null,
            },
            now,
          );
          flagged = row !== null && duplicate !== null;
          return row;
        });
        if (truncated > 0)
          metrics.inc('media_duplicate_scan_truncated_total', {}, truncated);
        if (!ready) {
          // Lost the claim (deleted, or taken over after the lease): nothing was written.
          finish('skipped', media);
          return 'SKIPPED';
        }
        if (flagged) metrics.inc('media_duplicate_suspected_total');
        if (media.uploadedAt)
          metrics.observe(
            'media_upload_to_ready_seconds',
            (deps.clock.now().getTime() - media.uploadedAt.getTime()) / 1000,
          );
        finish('ready', media);
        return 'READY';
      } catch (error) {
        if (error instanceof RejectedImageError) {
          logger.warn(
            'media refused',
            fields(media, { code: error.code, detail: error.detail }),
          );
          await reject(media, error.code, 'PROCESSING');
          finish('rejected', media);
          return 'REJECTED';
        }
        // Transient: end the lease so the next delivery does not wait for it; the attempt stays counted.
        await deps
          .tx(({ media: repo }) =>
            repo.releaseLease(media.id, deps.clock.now()),
          )
          .catch(() => undefined);
        metrics.inc('media_processing_total', { result: 'failed' });
        logger.error(
          'media processing failed',
          fields(media, { result: 'failed', reason: (error as Error).message }),
        );
        throw error instanceof TransientProcessingError
          ? error
          : new TransientProcessingError((error as Error).message, error);
      }
    },
  };
}
