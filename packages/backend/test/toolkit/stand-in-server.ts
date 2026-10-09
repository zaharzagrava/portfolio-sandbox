import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  createServer as createHttpServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
  at: number;
}

export type StandInHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  recorded: RecordedRequest,
) => void | Promise<void>;

export interface StandIn {
  port: number;
  /** Certificate (PEM) clients must trust (`ca`); only set for TLS stand-ins. */
  ca?: string;
  /** TCP connections accepted so far (an SSRF block must leave this at 0). */
  readonly connections: number;
  /** Connections currently open (a call that was aborted must not leave one behind). */
  readonly openConnections: number;
  readonly requests: RecordedRequest[];
  setHandler(handler: StandInHandler): void;
  close(): Promise<void>;
}

export interface StandInOptions {
  /** Serve HTTPS with a throw-away certificate valid for these DNS names (and 127.0.0.1). */
  tlsHosts?: string[];
  handler?: StandInHandler;
  /** Server keep-alive timeout in ms (Node default 5 s). */
  keepAliveTimeoutMs?: number;
}

/** One throw-away certificate per `tlsHosts` list; generated with the `openssl` binary the CI image already has. */
function makeCertificate(hosts: string[]): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'standin-'));
  try {
    const san = [...hosts.map((h) => `DNS:${h}`), 'IP:127.0.0.1'].join(',');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-days',
        '2',
        '-subj',
        `/CN=${hosts[0] ?? 'localhost'}`,
        '-addext',
        `subjectAltName=${san}`,
      ],
      { stdio: 'ignore' },
    );
    return {
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'c.pem'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function startStandIn(
  options: StandInOptions = {},
): Promise<StandIn> {
  let handler: StandInHandler =
    options.handler ??
    ((_req, res) =>
      void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'));
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks),
        at: Date.now(),
      };
      requests.push(recorded);
      Promise.resolve(handler(req, res, recorded)).catch(() => res.destroy());
    });
  };

  const tls = options.tlsHosts ? makeCertificate(options.tlsHosts) : undefined;
  const server: Server = tls
    ? createHttpsServer({ key: tls.key, cert: tls.cert }, onRequest)
    : createHttpServer(onRequest);
  // Raw TCP connections, so an attempt that never completes a TLS handshake still counts.
  server.on('connection', (socket: Socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });

  if (options.keepAliveTimeoutMs)
    server.keepAliveTimeout = options.keepAliveTimeoutMs;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    ca: tls?.cert,
    get connections() {
      return connections;
    },
    get openConnections() {
      return sockets.size;
    },
    requests,
    setHandler: (h) => {
      handler = h;
    },
    close: () =>
      new Promise<void>((resolve) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => resolve());
      }),
  };
}

/** Handler that answers a scripted list of responses in turn (the last one repeats). */
export function scripted(
  responses: {
    status: number;
    headers?: Record<string, string>;
    body?: string;
    delayMs?: number;
  }[],
): StandInHandler {
  let i = 0;
  return async (_req, res) => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.delayMs)
      await new Promise((resolve) => setTimeout(resolve, r.delayMs));
    res.writeHead(r.status, r.headers ?? {}).end(r.body ?? '');
  };
}

/** Streams `totalBytes` of JSON-looking text in chunks, honouring back-pressure, and records how many bytes it managed to write. */
export function streaming(
  totalBytes: number,
  written: { bytes: number } = { bytes: 0 },
): StandInHandler {
  return async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(64 * 1024, 'a');
    while (written.bytes < totalBytes && !res.destroyed) {
      written.bytes += chunk.length;
      if (!res.write(chunk))
        await new Promise((resolve) =>
          res.once('drain', resolve).once('close', resolve),
        );
    }
    if (!res.destroyed) res.end();
  };
}
