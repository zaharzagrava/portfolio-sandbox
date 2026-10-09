import * as net from 'node:net';

export type ProxyMode =
  /** Forward everything. */
  | 'pass'
  /** Close every new connection at once and cut the existing ones: "broker unreachable". */
  | 'refuse'
  /** Accept and read, forward nothing in either direction: "broker hangs". */
  | 'hang'
  /** Forward client → server, swallow server → client: the write lands but the acknowledgement never arrives. */
  | 'drop-acks';

/**
 * A real TCP proxy for fault injection (S53 test plan R-13): point the client under test at `proxy.port` and flip the
 * mode. Nothing is mocked; the client sees what a broken network or broker looks like.
 *
 *   const proxy = await TcpFaultProxy.start({ host: 'localhost', port: 9192 });
 *   // kafkajs: socketFactory: proxy.kafkaSocketFactory()
 *   proxy.mode = 'refuse';
 */
export class TcpFaultProxy {
  private server!: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private killCountdown = 0;
  private dropCountdown = 0;
  private killStyle: 'close' | 'blackhole' = 'close';
  /** Chunks the client sent through the proxy (requests, roughly): lets a test arm a fault at a known point. */
  clientChunks = 0;
  mode: ProxyMode = 'pass';
  /** Added to every forwarded chunk, both directions. */
  delayMs = 0;
  port = 0;

  private constructor(
    private readonly target: { host: string; port: number },
  ) {}

  static async start(target: {
    host: string;
    port: number;
  }): Promise<TcpFaultProxy> {
    const proxy = new TcpFaultProxy(target);
    proxy.server = net.createServer((client) => proxy.onClient(client));
    await new Promise<void>((resolve) =>
      proxy.server.listen(0, '127.0.0.1', resolve),
    );
    proxy.port = (proxy.server.address() as net.AddressInfo).port;
    return proxy;
  }

  /** kafkajs `socketFactory`: every connection, whatever the advertised broker address, goes through the proxy. */
  kafkaSocketFactory() {
    return ({ onConnect }: { onConnect: () => void }): net.Socket =>
      net.connect({ host: '127.0.0.1', port: this.port }, onConnect);
  }

  /**
   * Fault the next `count` client requests after the current one: the connection is closed (`close`) or the request
   * is swallowed and never answered (`blackhole`). Arm it once the client is connected and warm.
   */
  failNextRequests(
    count: number,
    style: 'close' | 'blackhole' = 'close',
  ): void {
    this.killCountdown = count;
    this.killStyle = style;
  }

  /**
   * Swallow the next `count` server → client chunks: the broker did the work but the acknowledgement never arrives
   * ("dropped acknowledgement"). Arm it once the client is connected and warm.
   */
  dropNextResponses(count: number): void {
    this.dropCountdown = count;
  }

  /** Cut every open connection (a network partition that heals when the mode is `pass` again). */
  sever(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.sever();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private later(fn: () => void): void {
    if (this.delayMs > 0) setTimeout(fn, this.delayMs);
    else fn();
  }

  private onClient(client: net.Socket): void {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => client.destroy());
    if (this.mode === 'refuse') {
      client.destroy();
      return;
    }
    const upstream = net.connect(this.target.port, this.target.host);
    this.sockets.add(upstream);
    upstream.on('close', () => {
      this.sockets.delete(upstream);
      client.destroy();
    });
    upstream.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());

    client.on('data', (chunk) => {
      this.clientChunks++;
      if (this.mode === 'refuse') return client.destroy();
      if (this.mode === 'hang') return;
      if (this.killCountdown > 0) {
        this.killCountdown--;
        if (this.killStyle === 'close') {
          client.destroy();
          upstream.destroy();
        }
        return;
      }
      this.later(() => upstream.write(chunk));
    });
    upstream.on('data', (chunk) => {
      if (this.mode === 'hang' || this.mode === 'drop-acks') return;
      if (this.mode === 'refuse') return;
      if (this.dropCountdown > 0) {
        this.dropCountdown--;
        return;
      }
      this.later(() => client.write(chunk));
    });
  }
}
