import { Socket } from 'node:net';
import type { Readable } from 'node:stream';

export type ScanResult = { clean: true } | { clean: false; signature: string };

const CHUNK = 64 * 1024;

/**
 * clamd INSTREAM protocol (no dependency): `zINSTREAM\0`, then chunks each
 * prefixed with a 4-byte big-endian length, then a zero-length chunk; clamd
 * replies "stream: OK" or "stream: <Signature> FOUND". The file is streamed
 * from S3 straight into clamd - never buffered whole in memory.
 */
export async function scanStream(host: string, port: number, source: Readable, timeoutMs = 120_000): Promise<ScanResult> {
  const socket = new Socket();
  socket.setTimeout(timeoutMs);
  const reply = new Promise<string>((resolve, reject) => {
    let data = '';
    socket.on('data', (d) => (data += d.toString()));
    socket.on('end', () => resolve(data.replace(/\0/g, '').trim()));
    socket.on('timeout', () => socket.destroy(new Error('clamd timeout')));
    socket.on('error', reject);
  });
  await new Promise<void>((resolve, reject) => socket.connect(port, host, resolve).once('error', reject));
  socket.write('zINSTREAM\0');
  for await (const chunk of source as AsyncIterable<Buffer>) {
    for (let i = 0; i < chunk.length; i += CHUNK) {
      const piece = chunk.subarray(i, i + CHUNK);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(piece.length);
      if (!socket.write(Buffer.concat([header, piece]))) await new Promise((r) => socket.once('drain', r)); // backpressure
    }
  }
  socket.end(Buffer.alloc(4)); // zero-length chunk = end of stream
  const text = await reply;
  if (/:\s*OK$/.test(text)) return { clean: true };
  const found = /:\s*(.+)\s+FOUND$/.exec(text);
  if (found) return { clean: false, signature: found[1] };
  throw new Error(`unexpected clamd reply: ${text}`);
}
