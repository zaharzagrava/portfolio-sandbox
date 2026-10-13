/**
 * Public entry point of the `media` domain (constitution X.4). Code outside this domain imports only from
 * `@app/domains/media`. This is the Provides list of S29 and nothing else: no model, no repository, no `Sql`, no
 * queue constant.
 */
export { MediaModule } from './media.module';
export { MediaWorkerModule } from './media-worker.module';
export { MediaProjectorModule } from './media-projector.module';
export { VideoModule, VideoWorkerModule } from './video.module';
export { MediaQueryService } from './application/media-query.service';
export type { MediaDto } from './application/media-view';
export { createMediaProcessor } from './infra/media-processor';
export type {
  MediaProcessorDeps,
  ProcessContext,
  ProcessResult,
  ProcessorLimits,
} from './infra/media-processor';
export { createTx } from './infra/media-tx';
export type {
  Blobs,
  MalwareScannerPort,
  MediaLogger,
  MediaMetrics,
  SqlRunner,
  Tx,
} from './domain/ports';
export { TransientProcessingError } from './domain/reject-code';
export { isOriginalKey } from './domain/upload-policy';
export {
  MediaDeleted,
  MediaDuplicateSuspected,
  MediaGalleryChanged,
  MediaReady,
  MediaRejected,
} from './domain/media-events';
export { mediaEventSchemas } from '@marketplace-sandbox/contracts';
