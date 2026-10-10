import { Injectable } from '@nestjs/common';
import { buffer } from 'node:stream/consumers';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import type {
  QueryIndexSnapshotStore,
  SnapshotObject,
} from '../domain/autocomplete-ports';

const PREFIX = 'autocomplete/';
const SUFFIX = '.json.gz';
const keyOf = (version: string): string => `${PREFIX}${version}${SUFFIX}`;

const isMissing = (error: unknown): boolean => {
  const e = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.Code === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
};

/** `QueryIndexSnapshotStore` over the object store: one immutable object per version at `autocomplete/<version>.json.gz`. */
@Injectable()
export class SnapshotStoreAdapter implements QueryIndexSnapshotStore {
  constructor(private readonly storage: ObjectStorage) {}

  put(version: string, body: Buffer): Promise<void> {
    return this.storage.put(keyOf(version), body, 'application/gzip');
  }

  async get(version: string): Promise<Buffer | null> {
    try {
      return await buffer(await this.storage.getStream(keyOf(version)));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async list(): Promise<SnapshotObject[]> {
    const objects = await this.storage.list(PREFIX);
    return objects
      .filter((o) => o.key.endsWith(SUFFIX))
      .map((o) => ({
        version: o.key.slice(PREFIX.length, -SUFFIX.length),
        lastModified: o.lastModified,
      }));
  }

  delete(version: string): Promise<void> {
    return this.storage.delete(keyOf(version));
  }
}
