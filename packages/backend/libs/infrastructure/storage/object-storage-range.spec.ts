import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ApiConfigService } from '@app/common/config';
import { InMemoryObjectStorage } from './in-memory-object-storage';
import { S3ObjectStorage } from './s3-object-storage';

describe('S07 storage extension (ranged read, A31)', () => {
  const config = {
    get: (k: string) =>
      (
        ({
          s3_endpoint: 'http://s3.internal:9000',
          media_bucket: 'media',
          aws_access_key_id: 'ak',
          aws_secret_access_key: 'sk',
          aws_region: 'eu-central-1',
        }) as Record<string, string>
      )[k],
  } as unknown as ApiConfigService;

  const read = async (stream: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  };

  it('S07 AS-34: in-memory getStream reads from a byte offset', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put('k', Buffer.from('0123456789'), 'text/csv');
    expect(await read(await storage.getStream('k'))).toBe('0123456789');
    expect(await read(await storage.getStream('k', { start: 4 }))).toBe(
      '456789',
    );
    expect(await read(await storage.getStream('k', { start: 0 }))).toBe(
      '0123456789',
    );
  });

  it('S07 AS-34: a start at or beyond the end is an empty stream, a missing key still throws', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put('k', Buffer.from('abc'), 'text/csv');
    expect(await read(await storage.getStream('k', { start: 3 }))).toBe('');
    expect(await read(await storage.getStream('k', { start: 99 }))).toBe('');
    await expect(storage.getStream('nope', { start: 1 })).rejects.toMatchObject(
      { name: 'NoSuchKey' },
    );
  });

  it('S07 AS-42: the stream handed out can be destroyed by the reader', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put('k', Buffer.alloc(1024 * 1024), 'text/csv');
    const stream = await storage.getStream('k', { start: 10 });
    stream.destroy();
    expect(stream.destroyed).toBe(true);
  });

  it('S07 AS-34: the S3 adapter asks for a Range from the offset, and for the whole object without one', async () => {
    const storage = new S3ObjectStorage(config);
    const inputs: Array<Record<string, unknown>> = [];
    jest
      .spyOn((storage as unknown as { client: S3Client }).client, 'send')
      .mockImplementation(((command: { input: Record<string, unknown> }) => {
        inputs.push(command.input);
        return Promise.resolve({ Body: Readable.from([Buffer.from('x')]) });
      }) as never);
    await storage.getStream('k');
    await storage.getStream('k', { start: 0 });
    await storage.getStream('k', { start: 1500 });
    expect(inputs.map((i) => i.Range)).toEqual([
      undefined,
      undefined,
      'bytes=1500-',
    ]);
  });

  it('S07 AS-34: the S3 adapter answers an offset beyond the end (416) with an empty stream', async () => {
    const storage = new S3ObjectStorage(config);
    jest
      .spyOn((storage as unknown as { client: S3Client }).client, 'send')
      .mockRejectedValue(
        Object.assign(new Error('Range Not Satisfiable'), {
          name: 'InvalidRange',
          $metadata: { httpStatusCode: 416 },
        }) as never,
      );
    expect(await read(await storage.getStream('k', { start: 99 }))).toBe('');
  });
});
