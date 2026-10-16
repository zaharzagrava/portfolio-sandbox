import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ApiConfigService } from '@app/common/config';
import { InMemoryObjectStorage } from './in-memory-object-storage';
import {
  attachmentDisposition,
  contentTypeCondition,
  StorageAbortedError,
  StorageStalledError,
} from './object-storage.port';
import { S3ObjectStorage } from './s3-object-storage';

describe('object storage port options (S29 R-4)', () => {
  it('S29 AS-06: one content type becomes an exact condition', () => {
    expect(contentTypeCondition({ contentTypes: ['image/png'] })).toEqual([
      'eq',
      '$Content-Type',
      'image/png',
    ]);
  });

  it('S29 AS-06: a closed set becomes the longest prefix they share (a POST policy has no list operator)', () => {
    expect(
      contentTypeCondition({
        contentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif'],
      }),
    ).toEqual(['starts-with', '$Content-Type', 'image/']);
    expect(
      contentTypeCondition({ contentTypes: ['image/jpeg', 'text/plain'] }),
    ).toEqual(['starts-with', '$Content-Type', '']);
  });

  it('keeps the prefix form for existing callers', () => {
    expect(contentTypeCondition({ contentTypePrefix: 'image/' })).toEqual([
      'starts-with',
      '$Content-Type',
      'image/',
    ]);
  });

  it('the in-memory double mirrors minBytes, cacheControl and head', async () => {
    const storage = new InMemoryObjectStorage();
    const post = await storage.presignPost({
      key: 'k',
      contentTypes: ['image/png'],
      minBytes: 1,
      maxBytes: 10,
    });
    expect(post.fields['Content-Type']).toBe('image/png');
    expect(post.fields.policy).toBe('min=1;max=10');
    await storage.put('a', Buffer.from('xyz'), 'image/webp', {
      cacheControl: 'public, max-age=1',
      timeoutMs: 10,
    });
    expect(storage.objects.get('a')?.cacheControl).toBe('public, max-age=1');
    expect(await storage.head('a', { timeoutMs: 10 })).toEqual({
      size: 3,
      contentType: 'image/webp',
      cacheControl: 'public, max-age=1',
    });
    expect(await storage.head('missing')).toBeNull();
  });
});

describe('object storage port additions (S30 G1)', () => {
  it('S30 AS-37: head returns the cache-control the object was stored with', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put('a', Buffer.from('x'), 'video/mp2t', {
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(await storage.head('a')).toEqual({
      size: 1,
      contentType: 'video/mp2t',
      cacheControl: 'public, max-age=31536000, immutable',
    });
  });

  it('S30 AS-09: listParts is null for an unknown upload and lists what is held, sorted', async () => {
    const storage = new InMemoryObjectStorage();
    expect(await storage.listParts('k', 'nope')).toBeNull();
    const { uploadId } = await storage.startMultipartUpload('k', 'video/mp4');
    storage.parts.get(uploadId)!.set(2, Buffer.alloc(5));
    storage.parts.get(uploadId)!.set(1, Buffer.alloc(3));
    expect(
      (await storage.listParts('k', uploadId))!.map((p) => [
        p.partNumber,
        p.size,
      ]),
    ).toEqual([
      [1, 3],
      [2, 5],
    ]);
  });

  it('S30 AS-10: completing assembles the parts in order, aborting forgets them', async () => {
    const storage = new InMemoryObjectStorage();
    const { uploadId } = await storage.startMultipartUpload('k', 'video/mp4');
    storage.parts.get(uploadId)!.set(1, Buffer.from('ab'));
    storage.parts.get(uploadId)!.set(2, Buffer.from('cd'));
    await storage.completeMultipartUpload('k', uploadId, [
      { partNumber: 2, etag: 'x' },
      { partNumber: 1, etag: 'y' },
    ]);
    expect(storage.objects.get('k')!.body.toString()).toBe('abcd');
    const other = await storage.startMultipartUpload('j', 'video/mp4');
    await storage.abortMultipartUpload('j', other.uploadId);
    expect(await storage.listParts('j', other.uploadId)).toBeNull();
  });

  it('S30 AS-52: deletePrefix removes only that prefix, bounded by the limit, and a missing prefix is fine', async () => {
    const storage = new InMemoryObjectStorage();
    for (const key of ['p/1/a', 'p/1/b', 'p/1/c', 'p/2/a'])
      await storage.put(key, Buffer.from('x'), 'text/plain');
    expect(await storage.deletePrefix('p/1/', { limit: 2 })).toBe(2);
    expect(await storage.deletePrefix('p/1/')).toBe(1);
    expect(await storage.deletePrefix('p/9/')).toBe(0);
    expect([...storage.objects.keys()]).toEqual(['p/2/a']);
  });

  it('S30 AS-08: presignUploadPart carries the exact length and part number', async () => {
    const storage = new InMemoryObjectStorage();
    const url = await storage.presignUploadPart('k', 'u1', 3, 1234);
    expect(url).toContain('part=3');
    expect(url).toContain('len=1234');
  });
});

describe('S12 storage extension (A20)', () => {
  const config = {
    get: (k: string) =>
      (
        ({
          s3_endpoint: 'http://s3.internal:9000',
          media_bucket: 'media',
          aws_access_key_id: 'ak',
          aws_secret_access_key: 'sk',
          aws_region: 'eu-central-1',
          usercontent_origin: 'https://files.example.com',
        }) as Record<string, string>
      )[k],
  } as unknown as ApiConfigService;

  it('S12 AS-33: in-memory put honours an already-aborted signal and leaves nothing behind', async () => {
    const storage = new InMemoryObjectStorage();
    const ac = new AbortController();
    ac.abort();
    await expect(
      storage.put('k', Readable.from([Buffer.from('a')]), 'text/csv', {
        signal: ac.signal,
      }),
    ).rejects.toBeInstanceOf(StorageAbortedError);
    expect(storage.objects.size).toBe(0);
    expect(storage.parts.size).toBe(0);
  });

  it('S12 AS-33: in-memory put aborted mid-stream discards the parts and writes no object', async () => {
    const storage = new InMemoryObjectStorage();
    const ac = new AbortController();
    const source = new Readable({ read() {} });
    source.push(Buffer.from('partial'));
    const put = storage.put('k', source, 'text/csv', { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(put).rejects.toBeInstanceOf(StorageAbortedError);
    expect(storage.objects.size).toBe(0);
    expect(storage.parts.size).toBe(0);
  });

  it('S12 AS-38: in-memory put aborts a stalled source after inactivityTimeoutMs', async () => {
    const storage = new InMemoryObjectStorage();
    const source = new Readable({ read() {} });
    source.push(Buffer.from('partial'));
    await expect(
      storage.put('k', source, 'text/csv', { inactivityTimeoutMs: 50 }),
    ).rejects.toBeInstanceOf(StorageStalledError);
    expect(storage.objects.size).toBe(0);
    expect(storage.parts.size).toBe(0);
  });

  it('S12 AS-38: in-memory put does not time out a source that keeps producing', async () => {
    const storage = new InMemoryObjectStorage();
    async function* slow() {
      for (const c of ['a', 'b', 'c']) {
        await new Promise((r) => setTimeout(r, 30));
        yield Buffer.from(c);
      }
    }
    await storage.put('k', Readable.from(slow()), 'text/csv', {
      inactivityTimeoutMs: 150,
    });
    expect(storage.objects.get('k')!.body.toString()).toBe('abc');
    expect(storage.parts.size).toBe(0);
  });

  it('S12 AS-33: in-memory abortMultipartUpload really discards the staged parts', async () => {
    const storage = new InMemoryObjectStorage();
    const { uploadId } = await storage.startMultipartUpload('k', 'text/csv');
    storage.parts.get(uploadId)!.set(1, Buffer.from('x'));
    await storage.abortMultipartUpload('k', uploadId);
    expect(storage.parts.has(uploadId)).toBe(false);
    expect(await storage.listParts('k', uploadId)).toBeNull();
  });

  describe('S3 adapter', () => {
    const MB = 1024 * 1024;
    function s3WithFakeClient() {
      const storage = new S3ObjectStorage(config);
      const sent: string[] = [];
      jest
        .spyOn((storage as unknown as { client: S3Client }).client, 'send')
        .mockImplementation(((command: { constructor: { name: string } }) => {
          const name = command.constructor.name;
          sent.push(name);
          if (name === 'CreateMultipartUploadCommand')
            return Promise.resolve({ UploadId: 'u1' });
          if (name === 'UploadPartCommand')
            return Promise.resolve({ ETag: '"e"' });
          return Promise.resolve({});
        }) as never);
      return { storage, sent };
    }

    it('S12 AS-33: put aborts the multipart upload when the signal fires and stores no object', async () => {
      const { storage, sent } = s3WithFakeClient();
      const ac = new AbortController();
      const source = new Readable({ read() {} });
      source.push(Buffer.alloc(9 * MB));
      const put = storage.put('k', source, 'text/csv', { signal: ac.signal });
      await new Promise((r) => setTimeout(r, 300));
      ac.abort();
      await expect(put).rejects.toBeInstanceOf(StorageAbortedError);
      expect(sent).toContain('CreateMultipartUploadCommand');
      expect(sent).toContain('AbortMultipartUploadCommand');
      expect(sent).not.toContain('CompleteMultipartUploadCommand');
    });

    it('S12 AS-38: put aborts a stalled source after inactivityTimeoutMs', async () => {
      const { storage, sent } = s3WithFakeClient();
      const source = new Readable({ read() {} });
      source.push(Buffer.alloc(9 * MB));
      await expect(
        storage.put('k', source, 'text/csv', { inactivityTimeoutMs: 400 }),
      ).rejects.toBeInstanceOf(StorageStalledError);
      expect(sent).toContain('AbortMultipartUploadCommand');
      expect(sent).not.toContain('CompleteMultipartUploadCommand');
    });

    it('S12 AS-50: presignGet sets attachment, RFC 6266 quoted filename, text/csv and the user-content origin', async () => {
      const storage = new S3ObjectStorage(config);
      const url = new URL(
        await storage.presignGet('exports/a/b.csv', {
          downloadName: 'orders-123.csv',
          contentType: 'text/csv',
          userContent: true,
        }),
      );
      expect(url.origin).toBe('https://files.example.com');
      expect(url.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="orders-123.csv"',
      );
      expect(url.searchParams.get('response-content-type')).toBe('text/csv');
    });

    it('S12 AS-50: presignGet keeps the storage origin without userContent and quotes the filename instead of percent-encoding it', async () => {
      const storage = new S3ObjectStorage(config);
      const url = new URL(
        await storage.presignGet('k', { downloadName: 'a "b".csv' }),
      );
      expect(url.origin).toBe('http://s3.internal:9000');
      expect(url.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="a _b_.csv"; filename*=UTF-8\'\'a%20%22b%22.csv',
      );
    });
  });

  it('S12 AS-50: in-memory presignGet mirrors disposition, content type and origin', async () => {
    const storage = new InMemoryObjectStorage();
    const url = new URL(
      await storage.presignGet('exports/x.csv', {
        downloadName: 'orders-9.csv',
        contentType: 'text/csv',
        userContent: true,
      }),
    );
    expect(url.origin).toBe('http://usercontent.storage.test');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="orders-9.csv"',
    );
    expect(url.searchParams.get('response-content-type')).toBe('text/csv');
  });

  it('S12 AS-50: attachmentDisposition quotes per RFC 6266', () => {
    expect(attachmentDisposition()).toBe('attachment');
    expect(attachmentDisposition('orders-1.csv')).toBe(
      'attachment; filename="orders-1.csv"',
    );
    expect(attachmentDisposition('é.csv')).toBe(
      'attachment; filename="_.csv"; filename*=UTF-8\'\'%C3%A9.csv',
    );
  });
});
