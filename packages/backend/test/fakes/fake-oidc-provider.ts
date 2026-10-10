import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  /** Parsed form body of a POST, or the query of a GET. */
  params: Record<string, string>;
}

export interface FakeClaims {
  sub: string;
  email?: string;
  email_verified?: unknown;
  name?: string;
  [claim: string]: unknown;
}

/** What goes wrong, on purpose. Everything is optional; unset = a well-behaved provider. */
export interface FakeFaults {
  discovery?:
    'issuer-mismatch' | 'http-endpoint' | 'oversize' | 'status-500' | 'hang';
  jwks?: 'status-500' | 'hang';
  token?:
    | 'status-400'
    | 'status-401'
    | 'status-500'
    | 'oversize'
    | 'not-json'
    | 'no-id-token'
    | 'hang';
  /** Overrides applied to the next ID token(s). */
  idToken?: {
    iss?: string;
    aud?: string | string[];
    azp?: string;
    nonce?: string | null;
    /** Seconds relative to now; `null` leaves the claim out. */
    exp?: number | null;
    alg?: 'none' | 'HS256' | 'ES256';
    /** Sign with a key the key set does not publish. */
    unknownKid?: boolean;
    /** Pad the token past the size cap. */
    oversize?: boolean;
  };
}

interface Grant {
  claims: FakeClaims;
  nonce: string | null;
  challenge: string;
  redirectUri: string;
  used: boolean;
}

const b64 = (value: Buffer | string) =>
  Buffer.from(value).toString('base64url');

/**
 * An in-process OpenID Connect provider for specs: discovery, key set, authorization "approval" and token endpoints,
 * ID tokens signed with a real key, every request recorded, and faults on demand. It verifies the PKCE
 * `code_verifier` itself, so a client that skips PKCE fails here and not only in a unit test.
 */
export class FakeOidcProvider {
  readonly clientId = 'fake-client-id';
  readonly clientSecret = 'fake-client-secret';
  requests: RecordedRequest[] = [];
  faults: FakeFaults = {};
  /** Authorization requests seen by `approve` (what the app put in the URL). */
  authorizations: Array<Record<string, string>> = [];

  private readonly sockets = new Set<import('node:net').Socket>();
  private readonly grants = new Map<string, Grant>();
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private readonly strangerKeys = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  private readonly kid = 'fake-key-1';

  private constructor(private readonly server: http.Server) {
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
  }

  static async start(): Promise<FakeOidcProvider> {
    const holder: { provider?: FakeOidcProvider } = {};
    const server = http.createServer(
      (req, res) => void holder.provider?.handle(req, res),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    holder.provider = new FakeOidcProvider(server);
    return holder.provider;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get host(): string {
    return '127.0.0.1';
  }

  get issuer(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Forget requests, grants and faults between tests. */
  reset(): void {
    this.requests = [];
    this.authorizations = [];
    this.faults = {};
    this.grants.clear();
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  /**
   * The user approving at the provider: reads the authorization URL the app produced, remembers the grant and returns
   * the URL the browser would be sent back to (`redirect_uri?code=…&state=…`).
   */
  approve(
    authorizationUrl: string,
    claims: FakeClaims,
    options: { error?: string } = {},
  ): string {
    const url = new URL(authorizationUrl);
    const p = Object.fromEntries(url.searchParams.entries());
    this.authorizations.push(p);
    const back = new URL(p.redirect_uri);
    back.searchParams.set('state', p.state);
    if (options.error) {
      back.searchParams.set('error', options.error);
      back.searchParams.set('error_description', 'secret provider text');
      return back.toString();
    }
    const code = b64(randomBytes(24));
    this.grants.set(code, {
      claims,
      nonce: p.nonce ?? null,
      challenge: p.code_challenge,
      redirectUri: p.redirect_uri,
      used: false,
    });
    back.searchParams.set('code', code);
    return back.toString();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', this.issuer);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const params =
      req.method === 'POST'
        ? Object.fromEntries(new URLSearchParams(raw).entries())
        : Object.fromEntries(url.searchParams.entries());
    this.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      headers: req.headers,
      params,
    });

    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const oversize = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      const f = this.faults.discovery;
      if (f === 'hang') return;
      if (f === 'status-500') return json(500, { error: 'server_error' });
      if (f === 'oversize') return oversize();
      return json(200, {
        issuer:
          f === 'issuer-mismatch' ? 'https://elsewhere.example' : this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint:
          f === 'http-endpoint'
            ? 'http://token.untrusted.example/token'
            : `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: [
          'client_secret_basic',
          'client_secret_post',
        ],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    }

    if (url.pathname === '/jwks') {
      const f = this.faults.jwks;
      if (f === 'hang') return;
      if (f === 'status-500') return json(500, { error: 'server_error' });
      return json(200, {
        keys: [
          {
            ...(this.keys.publicKey.export({ format: 'jwk' }) as object),
            kid: this.kid,
            use: 'sig',
            alg: 'ES256',
          },
        ],
      });
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const f = this.faults.token;
      if (f === 'hang') return;
      if (f === 'status-400') return json(400, { error: 'invalid_grant' });
      if (f === 'status-401') return json(401, { error: 'invalid_client' });
      if (f === 'status-500') return json(500, { error: 'server_error' });
      if (f === 'oversize') return oversize();
      if (f === 'not-json') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>not json</html>');
      }
      if (f === 'no-id-token')
        return json(200, {
          access_token: 'at-without-id-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });

      const grant = this.grants.get(params.code ?? '');
      const verifierOk =
        !!grant &&
        !!params.code_verifier &&
        createHash('sha256')
          .update(params.code_verifier)
          .digest('base64url') === grant.challenge;
      if (
        !grant ||
        grant.used ||
        !verifierOk ||
        params.redirect_uri !== grant.redirectUri ||
        params.grant_type !== 'authorization_code'
      )
        return json(400, { error: 'invalid_grant' });
      grant.used = true;
      return json(200, {
        access_token: `at-${b64(randomBytes(12))}`,
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: this.idToken(grant),
      });
    }

    res.writeHead(404);
    res.end();
  }

  /** Builds and signs the ID token for a grant, applying the injected faults. */
  idToken(grant: Pick<Grant, 'claims' | 'nonce'>): string {
    const o = this.faults.idToken ?? {};
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: o.iss ?? this.issuer,
      aud: o.aud ?? this.clientId,
      iat: now,
      exp: now + (o.exp ?? 3600),
      ...grant.claims,
    };
    if (o.exp === null) delete claims.exp;
    for (const [name, value] of Object.entries(claims))
      if (value === undefined) delete claims[name];
    if (o.azp) claims.azp = o.azp;
    const nonce = o.nonce === undefined ? grant.nonce : o.nonce;
    if (nonce !== null) claims.nonce = nonce;
    if (o.oversize) claims.pad = 'x'.repeat(9 * 1024);

    const alg = o.alg ?? 'ES256';
    const kid = o.unknownKid ? 'rotated-key-9' : this.kid;
    const header = { alg, typ: 'JWT', ...(alg === 'none' ? {} : { kid }) };
    const input = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
    if (alg === 'none') return `${input}.`;
    if (alg === 'HS256')
      return `${input}.${createHmac('sha256', this.clientSecret).update(input).digest('base64url')}`;
    const key: KeyObject = o.unknownKid
      ? this.strangerKeys.privateKey
      : this.keys.privateKey;
    const signed = cryptoSign('sha256', Buffer.from(input), {
      key,
      dsaEncoding: 'ieee-p1363',
    });
    return `${input}.${signed.toString('base64url')}`;
  }
}
