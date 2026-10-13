import { InMemoryObjectStorage } from './in-memory-object-storage';
import { contentTypeCondition } from './object-storage.port';

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
