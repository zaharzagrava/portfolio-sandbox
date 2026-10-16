import type { Readable } from 'node:stream';
import type { ImportProgressEvent } from '@marketplace-sandbox/contracts';

export const IMPORT_QUEUE = Symbol('IMPORT_QUEUE');
export const IMPORT_SHOP_STATUS = Symbol('IMPORT_SHOP_STATUS');
export const IMPORT_SHOP_ACCESS = Symbol('IMPORT_SHOP_ACCESS');
export const IMPORT_PUBLISHER = Symbol('IMPORT_PUBLISHER');
export const IMPORT_SCANNER = Symbol('IMPORT_SCANNER');

/** The `catalog-imports` queue: only `{ importId }` messages, and only `delaySeconds` as an option (standard queue, L-001). */
export interface ImportQueuePort {
  enqueue(importId: string, options?: { delaySeconds?: number }): Promise<void>;
}

/** Tenancy facts through R1: whether the shop may still be written to. */
export interface ImportShopStatusPort {
  isActive(shopId: string): Promise<boolean>;
}

/** Whether the user is a current member of the shop with `products.read` (topic policy, S51). */
export interface ImportShopAccessPort {
  canRead(shopId: string, userId: string): Promise<boolean>;
}

/** Live events of `import:<importId>`. Advisory: a failure never fails the import. */
export interface ImportPublisherPort {
  publish(importId: string, event: ImportProgressEvent): void;
}

export type ImportScanVerdict =
  | { kind: 'clean'; scan: 'clean' | 'skipped' }
  | { kind: 'infected'; signature: string };

/**
 * The malware scan of a source stream. Fail closed: an unreachable, stalled or confusing scanner throws (the delivery
 * fails and is retried); only a verdict lets the file through. Always consumes or destroys the stream.
 */
export interface ImportScannerPort {
  scan(
    source: Readable,
    options: { signal?: AbortSignal },
  ): Promise<ImportScanVerdict>;
}
