import { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import {
  MalwareScanner,
  ScannerUnavailableError,
  ScanOptions,
  ScanResult,
} from './malware-scanner';

const CHUNK = 64 * 1024;

/**
 * clamd INSTREAM protocol (no dependency): `zINSTREAM\0`, then chunks each prefixed with a 4-byte big-endian length,
 * then a zero-length chunk; clamd replies "stream: OK" or "stream: <Signature> FOUND". The file is streamed from
 * storage straight into clamd, never buffered whole, and the source is read only while the socket accepts bytes.
 *
 * The exchange ends at `timeoutMs` in total and, when `inactivityMs` is given, as soon as nothing has moved for that
 * long (a byte read from the source, a drain of the socket, a byte answered): a scan that keeps making progress is
 * never cut off early, a quiet socket or a stalled source is. On every exit path the socket and the source are
 * destroyed. An early reply (clamd answering `INSTREAM size limit exceeded. ERROR` while the file is still being sent)
 * ends the exchange at once.
 */
export async function scanStream(
  host: string,
  port: number,
  source: Readable,
  timeoutMs = 120_000,
  inactivityMs?: number,
): Promise<ScanResult> {
  const socket = new Socket();
  let idle: NodeJS.Timeout | undefined;
  let rejectAbandoned!: (error: Error) => void;
  const abandoned = new Promise<never>(
    (_, reject) => (rejectAbandoned = reject),
  );
  abandoned.catch(() => undefined);
  const abandon = (message: string) => {
    const error = new Error(message);
    socket.destroy(error);
    source.destroy();
    rejectAbandoned(error);
  };
  const touch = () => {
    if (inactivityMs === undefined) return;
    clearTimeout(idle);
    idle = setTimeout(() => abandon('clamd inactivity'), inactivityMs);
  };
  const total = setTimeout(() => abandon('clamd timeout'), timeoutMs);
  touch();

  const exchange = (async (): Promise<ScanResult> => {
    const reply = new Promise<string>((resolve, reject) => {
      let data = '';
      socket.on('data', (d) => {
        touch();
        data += d.toString();
      });
      socket.on('end', () => resolve(data.replace(/\0/g, '').trim()));
      socket.on('close', () => resolve(data.replace(/\0/g, '').trim()));
      socket.on('error', reject);
    });
    reply.catch(() => undefined);
    await new Promise<void>((resolve, reject) =>
      socket.connect(port, host, resolve).once('error', reject),
    );
    touch();
    const waitDrain = () =>
      new Promise<void>((resolve, reject) => {
        const onClose = () => reject(new Error('clamd closed the connection'));
        socket.once('close', onClose);
        socket.once('drain', () => {
          socket.off('close', onClose);
          touch();
          resolve();
        });
      });
    const sending = (async () => {
      socket.write('zINSTREAM\0');
      for await (const chunk of source as AsyncIterable<Buffer>) {
        touch();
        for (let i = 0; i < chunk.length; i += CHUNK) {
          const piece = chunk.subarray(i, i + CHUNK);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(piece.length);
          if (!socket.write(Buffer.concat([header, piece]))) await waitDrain();
        }
      }
      socket.end(Buffer.alloc(4)); // zero-length chunk = end of stream
    })();
    sending.catch(() => undefined);
    // the verdict, or an early reply while still sending (it ends the exchange: the file is not sent any further)
    const text = await Promise.race([reply, sending.then(() => reply)]);
    if (/:\s*OK$/.test(text)) return { clean: true };
    const found = /:\s*(.+)\s+FOUND$/.exec(text);
    if (found) return { clean: false, signature: found[1] };
    throw new Error(`unexpected clamd reply: ${text || '(empty)'}`);
  })();
  try {
    return await Promise.race([exchange, abandoned]);
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    socket.destroy();
    if (!source.destroyed) source.destroy();
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

  async scan(source: Readable, options: ScanOptions): Promise<ScanResult> {
    try {
      return await scanStream(
        this.host,
        this.port,
        source,
        options.timeoutMs,
        options.inactivityMs,
      );
    } catch (error) {
      throw new ScannerUnavailableError(
        `malware scanner unavailable: ${(error as Error).message}`,
        error,
      );
    }
  }
}
