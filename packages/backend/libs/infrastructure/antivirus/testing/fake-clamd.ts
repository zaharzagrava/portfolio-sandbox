import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';

export type FakeClamdMode =
  /** Decodes the INSTREAM frames; replies FOUND when the content holds `EICAR`, else OK. */
  | 'auto'
  /** Always reports `signature` as FOUND, after the terminator. */
  | 'infected'
  /** Replies `INSTREAM size limit exceeded. ERROR` as soon as `limitBytes` have arrived, then closes. */
  | 'size-limit'
  /** Accepts, reads the whole stream, closes without a word. */
  | 'empty'
  /** Replies half a verdict (`stream: Eicar-Te`) and closes. */
  | 'partial'
  /** Replies text that is neither OK, FOUND nor ERROR. */
  | 'garbage'
  /** Accepts the connection, reads and discards everything, never answers. */
  | 'stall'
  /** Reads the command and `stallAfterBytes` of content, then stops reading and answering. */
  | 'stall-mid';

/**
 * A fake scanner server that speaks the real clamd streaming protocol over TCP (S07 test-plan: system-edge fake).
 * `zINSTREAM\0`, then chunks each prefixed with a 4-byte big-endian length, then a zero-length terminator; the reply is
 * `stream: OK\0` or `stream: <Signature> FOUND\0`. It records what it saw so a spec can assert on chunk sizes, bytes
 * and connection counts, and `perChunkDelayMs` makes a scan slow but progressing.
 */
export class FakeClamd {
  mode: FakeClamdMode = 'auto';
  signature = 'Eicar-Test-Signature';
  limitBytes = 1024 * 1024;
  stallAfterBytes = 128 * 1024;
  perChunkDelayMs = 0;

  connections = 0;
  readonly commands: string[] = [];
  readonly chunkSizes: number[] = [];
  received = Buffer.alloc(0);
  /** Sockets that are still open (a scan that ended must have closed its socket). */
  private open = new Set<Socket>();
  private server: Server | undefined;
  private port = 0;

  get openSockets(): number {
    return this.open.size;
  }

  async start(): Promise<number> {
    if (this.server?.listening) return this.port;
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) =>
      this.server!.listen(this.port, '127.0.0.1', resolve),
    );
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  address(): string {
    return `127.0.0.1:${this.port}`;
  }

  /** Stops listening (new connections are refused) and drops the open ones; `start()` brings it back on the same port. */
  async refuse(): Promise<void> {
    for (const s of this.open) s.destroy();
    this.open.clear();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    this.server = undefined;
  }

  async stop(): Promise<void> {
    await this.refuse();
  }

  reset(): void {
    for (const s of this.open) s.destroy();
    this.open.clear();
    this.connections = 0;
    this.commands.length = 0;
    this.chunkSizes.length = 0;
    this.received = Buffer.alloc(0);
    this.mode = 'auto';
    this.perChunkDelayMs = 0;
  }

  private handle(socket: Socket): void {
    this.connections += 1;
    this.open.add(socket);
    socket.on('close', () => this.open.delete(socket));
    socket.on('error', () => undefined);
    if (this.mode === 'stall') {
      socket.on('data', () => undefined); // reads and discards, never answers; a closed client is still noticed
      return;
    }
    let buf = Buffer.alloc(0);
    let commandRead = false;
    let seen = 0;
    const reply = (text: string, end = true) => {
      if (socket.destroyed) return;
      if (end) socket.end(text);
      else socket.write(text);
    };
    const process = () => {
      if (!commandRead) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        this.commands.push(buf.subarray(0, nul).toString());
        buf = buf.subarray(nul + 1);
        commandRead = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          this.finish(reply);
          return;
        }
        if (buf.length < 4 + len) return;
        this.chunkSizes.push(len);
        this.received = Buffer.concat([
          this.received,
          buf.subarray(4, 4 + len),
        ]);
        seen += len;
        buf = buf.subarray(4 + len);
        if (this.mode === 'size-limit' && seen > this.limitBytes) {
          reply('INSTREAM size limit exceeded. ERROR\0');
          return;
        }
        if (this.mode === 'stall-mid' && seen >= this.stallAfterBytes) {
          socket.pause();
          return;
        }
        if (this.perChunkDelayMs > 0) {
          socket.pause();
          setTimeout(() => {
            if (!socket.destroyed) {
              socket.resume();
              process();
            }
          }, this.perChunkDelayMs);
          return;
        }
      }
    };
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      process();
    });
  }

  private finish(reply: (text: string, end?: boolean) => void): void {
    switch (this.mode) {
      case 'infected':
        return reply(`stream: ${this.signature} FOUND\0`);
      case 'empty':
        return reply('');
      case 'partial':
        return reply('stream: Eicar-Te');
      case 'garbage':
        return reply('what is this\0');
      case 'size-limit':
        return reply('INSTREAM size limit exceeded. ERROR\0');
      default:
        return reply(
          this.received.includes('EICAR')
            ? `stream: ${this.signature} FOUND\0`
            : 'stream: OK\0',
        );
    }
  }
}
