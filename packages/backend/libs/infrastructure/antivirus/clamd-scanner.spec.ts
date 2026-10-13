import { createServer, AddressInfo, Server, Socket } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { ClamdMalwareScanner } from './clamd-scanner';
import { ScannerUnavailableError } from './malware-scanner';

describe('clamd malware scanner port', () => {
  let silent: Server;
  let silentPort: number;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    silent = createServer((socket) => {
      sockets.push(socket); // accepts, never answers
    });
    await new Promise<void>((resolve) =>
      silent.listen(0, '127.0.0.1', resolve),
    );
    silentPort = (silent.address() as AddressInfo).port;
  });
  afterAll(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => silent.close(resolve));
  });

  it('S29 AS-19: a scanner that never answers ends at the timeout as unavailable', async () => {
    const scanner = new ClamdMalwareScanner('127.0.0.1', silentPort);
    const started = Date.now();
    await expect(
      scanner.scan(Readable.from(Buffer.from('abc')), { timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('S29 AS-19: a source that stalls ends at the timeout too', async () => {
    const scanner = new ClamdMalwareScanner('127.0.0.1', silentPort);
    await expect(
      scanner.scan(new PassThrough(), { timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
  });

  it('S29 AS-19: a refused connection is unavailable, not a verdict', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const scanner = new ClamdMalwareScanner('127.0.0.1', port);
    await expect(
      scanner.scan(Readable.from(Buffer.from('abc')), { timeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
});
