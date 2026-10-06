import { createServer, Server } from 'node:net';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { scanStream } from './clamav';

/** INSTREAM framing against a fake clamd that decodes chunks exactly like the real one. */
describe('clamd INSTREAM client', () => {
  let server: Server;
  let port: number;
  let received = Buffer.alloc(0);

  beforeAll(async () => {
    server = createServer((socket) => {
      let buf = Buffer.alloc(0);
      let commandRead = false;
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!commandRead) {
          const nul = buf.indexOf(0);
          if (nul < 0) return;
          expect(buf.subarray(0, nul).toString()).toBe('zINSTREAM');
          buf = buf.subarray(nul + 1);
          commandRead = true;
        }
        for (;;) {
          if (buf.length < 4) return;
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            socket.end(received.includes('EICAR') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (buf.length < 4 + len) return;
          received = Buffer.concat([received, buf.subarray(4, 4 + len)]);
          buf = buf.subarray(4 + len);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => server.close());
  beforeEach(() => (received = Buffer.alloc(0)));

  it('streams a large file in ≤ 64 KB framed chunks and reports clean', async () => {
    const file = Buffer.alloc(300_000, 'a');
    expect(await scanStream('127.0.0.1', port, Readable.from([file.subarray(0, 100_000), file.subarray(100_000)]))).toEqual({ clean: true });
    expect(received.equals(file)).toBe(true);
  });

  it('reports the signature of an infected file', async () => {
    expect(await scanStream('127.0.0.1', port, Readable.from([Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]))).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
  });
});
