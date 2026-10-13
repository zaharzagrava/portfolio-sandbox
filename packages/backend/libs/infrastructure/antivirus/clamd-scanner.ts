import { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import {
  MalwareScanner,
  ScannerUnavailableError,
  ScanResult,
} from './malware-scanner';

const CHUNK = 64 * 1024;

/**
 * clamd INSTREAM protocol (no dependency): `zINSTREAM\0`, then chunks each prefixed with a 4-byte big-endian length,
 * then a zero-length chunk; clamd replies "stream: OK" or "stream: <Signature> FOUND". The file is streamed from
 * storage straight into clamd, never buffered whole. The whole exchange, including a source that stalls, ends at
 * `timeoutMs` (the socket is destroyed, the source is destroyed, the call rejects).
 */
export async function scanStream(
  host: string,
  port: number,
  source: Readable,
  timeoutMs = 120_000,
): Promise<ScanResult> {
  const socket = new Socket();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('clamd timeout');
      socket.destroy(error);
      source.destroy();
      reject(error);
    }, timeoutMs);
  });
  expired.catch(() => undefined);
  const exchange = (async (): Promise<ScanResult> => {
    const reply = new Promise<string>((resolve, reject) => {
      let data = '';
      socket.on('data', (d) => (data += d.toString()));
      socket.on('end', () => resolve(data.replace(/\0/g, '').trim()));
      socket.on('error', reject);
    });
    reply.catch(() => undefined);
    await new Promise<void>((resolve, reject) =>
      socket.connect(port, host, resolve).once('error', reject),
    );
    socket.write('zINSTREAM\0');
    for await (const chunk of source as AsyncIterable<Buffer>) {
      for (let i = 0; i < chunk.length; i += CHUNK) {
        const piece = chunk.subarray(i, i + CHUNK);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(piece.length);
        if (!socket.write(Buffer.concat([header, piece])))
          await new Promise((r) => socket.once('drain', r)); // backpressure
      }
    }
    socket.end(Buffer.alloc(4)); // zero-length chunk = end of stream
    const text = await reply;
    if (/:\s*OK$/.test(text)) return { clean: true };
    const found = /:\s*(.+)\s+FOUND$/.exec(text);
    if (found) return { clean: false, signature: found[1] };
    throw new Error(`unexpected clamd reply: ${text}`);
  })();
  try {
    return await Promise.race([exchange, expired]);
  } finally {
    clearTimeout(timer);
    socket.destroy();
    exchange.catch(() => undefined);
  }
}

export class ClamdMalwareScanner extends MalwareScanner {
  constructor(
    private readonly host: string,
    private readonly port = 3310,
  ) {
    super();
  }

  /** `clamav:3310` → host and port. */
  static fromAddress(address: string): ClamdMalwareScanner {
    const [host, port] = address.split(':');
    return new ClamdMalwareScanner(host, Number(port ?? 3310));
  }

  async scan(
    source: Readable,
    { timeoutMs }: { timeoutMs: number },
  ): Promise<ScanResult> {
    try {
      return await scanStream(this.host, this.port, source, timeoutMs);
    } catch (error) {
      throw new ScannerUnavailableError(
        `malware scanner unavailable: ${(error as Error).message}`,
        error,
      );
    }
  }
}
