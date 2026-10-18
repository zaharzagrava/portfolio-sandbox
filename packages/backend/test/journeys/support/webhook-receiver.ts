import { execFileSync } from 'node:child_process';
import {
  createHash,
  createHmac,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  verifySignatureWith,
  WEBHOOK_HEADERS,
} from '@marketplace-sandbox/contracts';

/** The receiver-side reference verifier of S43 (the published scheme), built on the shared contract function. */
const verifyWebhook = (
  body: string,
  header: string | undefined,
  secret: string,
  { now }: { now: number },
): boolean =>
  verifySignatureWith(
    (key, message) => createHmac('sha256', key).update(message).digest('hex'),
    (a, b) => {
      const x = Buffer.from(a);
      const y = Buffer.from(b);
      return x.length === y.length && timingSafeEqual(x, y);
    },
    { body, header, secret, nowMs: now },
  );

export type ReceiverAnswer = 200 | 500 | 'hang';

/** Default port of the receiver; the local stack lists `127.0.0.1:18443` in `ALLOWED_RECEIVER_HOSTS`. */
export const RECEIVER_PORT = 18443;

export interface ReceivedWebhook {
  /** `id` of the event body. */
  id: string;
  deliveryId: string;
  attempt: number;
  type: string;
  replay: boolean;
  /** Whether the signature verified with the receiver's secret (S43's reference verifier). */
  verified: boolean;
  body: Record<string, any>;
}

/**
 * The receiver `R` of the seller journey: an HTTPS server on a fixed local port with a self-signed certificate made at start
 * (HTTPS in every profile, G-32). Its `host` is what the stack's `ALLOWED_RECEIVER_HOSTS` setting lists; `caFingerprint` is
 * only needed when that setting also pins the certificate.
 * `answer` scripts the status of the Nth request (1-based); the default is 200. `hang` never answers (the sender times out).
 */
export class WebhookReceiver {
  readonly received: ReceivedWebhook[] = [];
  /** Every request, including the ones whose signature failed. */
  requests = 0;
  /** Signing secret of the endpoint (shown once at creation); set it before the first delivery. */
  secret = '';
  /** Milliseconds the stack's clock is ahead of this machine's (0 unless the journey moved it): the signature is checked against stack time. */
  clockSkewMs = 0;
  private script: (request: number) => ReceiverAnswer = () => 200;
  private hanging: ServerResponse[] = [];

  private constructor(
    private readonly server: Server,
    readonly port: number,
    readonly caFingerprint: string,
    private readonly dir: string,
  ) {}

  static async start(
    listenOn: number = Number(
      process.env.JOURNEY_RECEIVER_PORT ?? RECEIVER_PORT,
    ),
  ): Promise<WebhookReceiver> {
    const dir = mkdtempSync(join(tmpdir(), 'j02-receiver-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    const cert = readFileSync(join(dir, 'cert.pem'));
    const caFingerprint = createHash('sha256')
      .update(new X509Certificate(cert).raw)
      .digest('hex');
    const server = createServer(
      { key: readFileSync(join(dir, 'key.pem')), cert },
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (c: Buffer) => chunks.push(c));
        request.on('end', () =>
          receiver.handle(
            request,
            response,
            Buffer.concat(chunks).toString('utf8'),
          ),
        );
      },
    );
    // A fixed port: the stack's `ALLOWED_RECEIVER_HOSTS` is static, so the receiver must be where the list says.
    const port = listenOn;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const receiver = new WebhookReceiver(
      server,
      (server.address() as AddressInfo).port,
      caFingerprint,
      dir,
    );
    return receiver;
  }

  /** `host:port` as the stack's `allowedReceiverHosts` lists it. */
  get host(): string {
    return `127.0.0.1:${this.port}`;
  }

  /** The URL an endpoint is created with. */
  url(path = '/hook'): string {
    return `https://${this.host}${path}`;
  }

  /** Scripts the answer by request number (1-based); replaces the previous script. */
  answer(script: ReceiverAnswer | ((request: number) => ReceiverAnswer)): void {
    this.script = typeof script === 'function' ? script : () => script;
  }

  /** Deliveries received for one event id, in arrival order. */
  forEvent(eventId: string): ReceivedWebhook[] {
    return this.received.filter((r) => r.id === eventId);
  }

  ofType(type: string): ReceivedWebhook[] {
    return this.received.filter((r) => r.type === type);
  }

  private handle(
    request: IncomingMessage,
    response: ServerResponse,
    raw: string,
  ): void {
    this.requests += 1;
    const header = (name: string) => {
      const v = request.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const answer = this.script(this.requests);
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* a non-JSON body is recorded as empty */
    }
    this.received.push({
      id: String(body.id ?? ''),
      deliveryId: header(WEBHOOK_HEADERS.deliveryId) ?? '',
      attempt: Number(header(WEBHOOK_HEADERS.attempt) ?? 0),
      type: header(WEBHOOK_HEADERS.eventType) ?? String(body.type ?? ''),
      replay: header(WEBHOOK_HEADERS.replay) === 'true',
      verified:
        this.secret !== '' &&
        verifyWebhook(raw, header(WEBHOOK_HEADERS.signature), this.secret, {
          now: Date.now() + this.clockSkewMs,
        }),
      body,
    });
    if (answer === 'hang') {
      this.hanging.push(response);
      return;
    }
    response.statusCode = answer;
    response.end('{}');
  }

  async stop(): Promise<void> {
    for (const r of this.hanging) r.destroy();
    this.hanging = [];
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
    rmSync(this.dir, { recursive: true, force: true });
  }
}
