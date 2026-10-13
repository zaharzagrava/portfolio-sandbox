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
    });
    expect(await storage.head('missing')).toBeNull();
  });
});
