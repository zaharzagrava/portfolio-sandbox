import { Inject, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { REPORT_HEADER } from '../domain/error-report';
import {
  IMPORT_LIMITS,
  importReportKey,
  importReportPrefix,
} from '../domain/import-limits';
import {
  ImportSourceMissingError,
  type ImportStoragePort,
  type ImportStoredPart,
} from '../domain/ports';

const CALL_TIMEOUT_MS = 30_000;
const REPORT_INACTIVITY_MS = 60_000;
const DELETE_PAGE = 1000;
const CSV = 'text/csv; charset=utf-8';
const PART_KEY = /\/report\/\d{8}\.csv$/;

const isMissing = (error: unknown): boolean => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.name === 'NoSuchUpload' ||
    e.$metadata?.httpStatusCode === 404
  );
};

/**
 * Object storage side of the import (S07 D-09, D-13, FR-044). Keys come from ids only (`domain/import-limits.ts`).
 * Parts are signed one by one with their exact length, so a client cannot send more bytes than declared. The report is
 * written batch by batch (`put` replaces a part, so a redone batch never duplicates lines) and joined into one object
 * at the end. Download links go to the separate user-content origin as a ten-minute attachment. Keys and links are
 * never logged. Delete paths treat "already gone" as success (L-016).
 */
@Injectable()
export class ImportStorageAdapter implements ImportStoragePort {
  constructor(
    private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async startUpload(key: string): Promise<{ uploadHandle: string }> {
    const { uploadId } = await this.storage.startMultipartUpload(
      key,
      'application/octet-stream',
      { timeoutMs: CALL_TIMEOUT_MS },
    );
    return { uploadHandle: uploadId };
  }

  signPart(
    key: string,
    uploadHandle: string,
    partNumber: number,
    length: number,
  ): Promise<string> {
    return this.storage.presignUploadPart(
      key,
      uploadHandle,
      partNumber,
      length,
      IMPORT_LIMITS.uploadUrlTtlSec,
    );
  }

  async listParts(
    key: string,
    uploadHandle: string,
  ): Promise<ImportStoredPart[] | null> {
    const parts = await this.storage.listParts(key, uploadHandle, {
      timeoutMs: CALL_TIMEOUT_MS,
    });
    return parts
      ? parts.map((p) => ({
          partNumber: p.partNumber,
          etag: p.etag,
          size: p.size,
        }))
      : null;
  }

  completeUpload(
    key: string,
    uploadHandle: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void> {
    return this.storage.completeMultipartUpload(key, uploadHandle, parts, {
      timeoutMs: 120_000,
    });
  }

  async abortUpload(key: string, uploadHandle: string): Promise<void> {
    try {
      await this.storage.abortMultipartUpload(key, uploadHandle, {
        timeoutMs: CALL_TIMEOUT_MS,
      });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async headSize(key: string): Promise<number | null> {
    return (
      (await this.storage.head(key, { timeoutMs: CALL_TIMEOUT_MS }))?.size ??
      null
    );
  }

  async openSource(
    key: string,
    startByte: number,
    signal?: AbortSignal,
  ): Promise<Readable> {
    let stream: Readable;
    try {
      stream = await this.storage.getStream(key, { start: startByte });
    } catch (error) {
      if (isMissing(error)) throw new ImportSourceMissingError();
      throw error;
    }
    if (signal) {
      const stop = () => stream.destroy();
      if (signal.aborted) stop();
      else {
        signal.addEventListener('abort', stop, { once: true });
        stream.once('close', () => signal.removeEventListener('abort', stop));
      }
    }
    return stream;
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async putReportPart(
    shopId: string,
    importId: string,
    batch: number,
    lines: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = `${importReportPrefix(shopId, importId)}${String(batch).padStart(8, '0')}.csv`;
    await this.storage.put(key, Buffer.from(lines, 'utf8'), CSV, {
      timeoutMs: CALL_TIMEOUT_MS,
      signal,
    });
  }

  async finaliseReport(
    shopId: string,
    importId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const finalKey = importReportKey(shopId, importId);
    const parts = (
      await this.storage.list(importReportPrefix(shopId, importId))
    )
      .map((o) => o.key)
      .filter((key) => PART_KEY.test(key))
      .sort();
    if (parts.length === 0)
      return (await this.storage.head(finalKey)) ? finalKey : null;
    const storage = this.storage;
    const body = Readable.from(
      (async function* () {
        yield Buffer.from(`${REPORT_HEADER}\n`);
        for (const key of parts) {
          const stream = await storage.getStream(key);
          for await (const chunk of stream) yield chunk as Buffer;
        }
      })(),
    );
    // the joined object is stored before the parts go: a crash in between redoes the join from the parts
    await this.storage.put(finalKey, body, CSV, {
      signal,
      inactivityTimeoutMs: REPORT_INACTIVITY_MS,
    });
    for (const key of parts) await this.deleteObject(key);
    return finalKey;
  }

  async signReportDownload(
    key: string,
    downloadName: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const url = await this.storage.presignGet(key, {
      expiresInSec: IMPORT_LIMITS.reportLinkTtlSec,
      downloadName,
      contentType: CSV,
      userContent: true,
    });
    return {
      url,
      expiresAt: new Date(
        this.clock.now().getTime() + IMPORT_LIMITS.reportLinkTtlSec * 1000,
      ),
    };
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (;;) {
      const removed = await this.storage.deletePrefix(prefix, {
        limit: DELETE_PAGE,
        timeoutMs: CALL_TIMEOUT_MS,
      });
      if (removed < DELETE_PAGE) return;
    }
  }
}
