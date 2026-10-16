import { Injectable } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import type { ExportFilesPort, ExportSink } from '../domain/export-ports';

/**
 * Object storage side of the export (S12 FR-014, FR-016, FR-033). `open` returns a writable that feeds one multipart
 * upload; backpressure from the upload propagates to whoever writes. The key is per attempt (`attempt-<n>-<token>`), so
 * a stale worker can never overwrite the file of the attempt that won; only the fenced completion makes a key the
 * export's file. Keys and links are never logged.
 */
@Injectable()
export class ExportFileSink implements ExportFilesPort {
  constructor(private readonly storage: ObjectStorage) {}

  open(key: string, options: { inactivityMs: number }): Promise<ExportSink> {
    const stream = new PassThrough();
    const controller = new AbortController();
    const upload = this.storage.put(key, stream, 'text/csv', {
      signal: controller.signal,
      inactivityTimeoutMs: options.inactivityMs,
    });
    // A failed or stalled upload ends the writable too, so whoever writes to it (the pipeline) is released with the error.
    upload.catch((error: unknown) =>
      stream.destroy(error instanceof Error ? error : new Error(String(error))),
    );
    const done = (async () => {
      await upload;
      const head = await this.storage.head(key);
      return { bytes: head?.size ?? 0 };
    })();
    done.catch(() => undefined);
    return Promise.resolve({
      stream,
      done,
      abort: async (reason?: unknown) => {
        controller.abort(reason);
        stream.destroy();
        await upload.catch(() => undefined);
      },
    });
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return (await this.storage.list(prefix)).map((object) => object.key);
  }

  async headSize(key: string): Promise<number | null> {
    return (await this.storage.head(key))?.size ?? null;
  }

  async presign(input: {
    key: string;
    fileName: string;
    ttlSec: number;
  }): Promise<string> {
    return this.storage.presignGet(input.key, {
      expiresInSec: input.ttlSec,
      downloadName: input.fileName,
      contentType: 'text/csv',
      userContent: true,
    });
  }
}
