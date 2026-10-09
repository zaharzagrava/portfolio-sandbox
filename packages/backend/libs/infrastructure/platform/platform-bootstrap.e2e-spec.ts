import { INestApplication, Logger } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import * as joi from 'joi';
import request from 'supertest';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import {
  EventLoopMonitor,
  LAG_SOURCE,
  LagSource,
} from '@app/common/load-shedding/event-loop-monitor.service';
import { configWith } from '@app/test/toolkit/config-stub';
import { pipelineStages } from '@app/test/toolkit/test-controller.module';
import { createToolkitApp } from '@app/test/toolkit/test-app';
import { configureHttpApp } from './bootstrap-http';

const ORIGIN = 'https://app.example';
const PRODUCTION = {
  node_env: 'production',
  cors_allowed_origins: ORIGIN,
  trusted_proxies: 'none',
  platform_currency: 'USD',
};

class FakeLagSource implements LagSource {
  private onWindow?: (p99Ms: number) => void;
  start(onWindow: (p99Ms: number) => void): void {
    this.onWindow = onWindow;
  }
  stop(): void {}
  emit(p99Ms: number): void {
    this.onWindow!(p99Ms);
  }
}

describe('platform bootstrap (BOOT)', () => {
  const apps: INestApplication[] = [];
  const boot = async (
    options: Parameters<typeof configureHttpApp>[1] = {},
    config: Record<string, unknown> = {},
    customize: (b: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
  ) => {
    const stub = await configWith(config);
    const app = await createToolkitApp({
      customize: (b) =>
        customize(b.overrideProvider(ApiConfigService).useValue(stub)),
      configureApp: (a) =>
        configureHttpApp(a, {
          useStructuredLogger: false,
          processHandlers: false,
          globalPrefix: false,
          ...options,
        }),
    });
    apps.push(app);
    return app;
  };
  const http = (app: INestApplication) => request(app.getHttpServer());

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  it('S54 AS-68: the server keeps connections 65 s, waits 66 s for headers and sets a request timeout', async () => {
    const app = await boot();
    const server = app.getHttpServer() as Server;
    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.headersTimeout).toBe(66_000);
    expect(server.requestTimeout).toBe(30_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it.each([60_000, 30_000, 1_000])(
    'S54 AS-68: a keep-alive timeout of %i ms (not above the load balancer idle timeout) fails startup',
    async (keepAliveMs) => {
      await expect(
        boot({
          shutdown: { keepAliveMs, headersTimeoutMs: keepAliveMs + 1_000 },
        }),
      ).rejects.toThrow(/keep-alive/);
    },
  );

  describe('AS-132 security headers', () => {
    const strict = {
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-site',
      'cross-origin-opener-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    };

    it.each([
      ['a success', '/t/ok', 200],
      ['a 404', '/t/missing', 404],
      ['a 500', '/t/type-error', 500],
      ['a probe', '/health/live', 200],
    ])(
      'S54 AS-132: %s carries the strict headers, no X-Powered-By and no HSTS outside production',
      async (_label, path, status) => {
        const res = await http(await boot())
          .get(path)
          .expect(status);
        expect(res.headers).toMatchObject(strict);
        expect(res.headers['x-powered-by']).toBeUndefined();
        expect(res.headers['strict-transport-security']).toBeUndefined();
      },
    );

    it('S54 AS-132: production adds HSTS on success, 404 and 500', async () => {
      const app = await boot({}, PRODUCTION);
      for (const [path, status] of [
        ['/t/ok', 200],
        ['/t/missing', 404],
        ['/t/type-error', 500],
      ] as const) {
        const res = await http(app).get(path).expect(status);
        expect(res.headers['strict-transport-security']).toBe(
          'max-age=31536000; includeSubDomains',
        );
        expect(res.headers).toMatchObject(strict);
      }
    });

    it('S54 AS-133: a public-embed route is open to every origin without credentials; the rest stays strict', async () => {
      const app = await boot({}, { cors_allowed_origins: ORIGIN });
      const embed = await http(app)
        .get('/t/embed')
        .set('Origin', 'https://anywhere.example')
        .expect(200);
      expect(embed.headers['access-control-allow-origin']).toBe('*');
      expect(embed.headers['access-control-allow-credentials']).toBeUndefined();
      expect(embed.headers['cross-origin-resource-policy']).toBe(
        'cross-origin',
      );
      const other = await http(app)
        .get('/t/ok')
        .set('Origin', 'https://anywhere.example')
        .expect(200);
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
      expect(other.headers['cross-origin-resource-policy']).toBe('same-site');
    });
  });

  describe('AS-134 CORS', () => {
    it('S54 AS-134: an allowed origin is echoed with credentials and the exposed headers; another origin gets no CORS header', async () => {
      const app = await boot({}, { cors_allowed_origins: ORIGIN });
      const allowed = await http(app)
        .get('/t/ok')
        .set('Origin', ORIGIN)
        .expect(200);
      expect(allowed.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(allowed.headers.vary).toMatch(/Origin/);
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      const exposed = String(
        allowed.headers['access-control-expose-headers'],
      ).toLowerCase();
      for (const name of [
        'x-request-id',
        'retry-after',
        'ratelimit',
        'ratelimit-policy',
        'etag',
        'idempotency-replayed',
        'deprecation',
        'sunset',
        'link',
      ])
        expect(exposed).toContain(name);
      const evil = await http(app)
        .get('/t/ok')
        .set('Origin', 'https://evil.example')
        .expect(200);
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('S54 AS-134: a preflight from the allowed origin is answered with the allowed headers and a 10 minute max-age', async () => {
      const app = await boot({}, { cors_allowed_origins: ORIGIN });
      const res = await http(app)
        .options('/t/validate')
        .set('Origin', ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set(
          'Access-Control-Request-Headers',
          'idempotency-key, authorization, content-type, x-request-id, if-match',
        );
      expect(res.status).toBeLessThan(300);
      const allowed = String(
        res.headers['access-control-allow-headers'],
      ).toLowerCase();
      for (const name of [
        'idempotency-key',
        'authorization',
        'content-type',
        'x-request-id',
        'if-match',
      ])
        expect(allowed).toContain(name);
      expect(res.headers['access-control-max-age']).toBe('600');
    });

    it('S54 AS-135: production with an empty allowlist, or a wildcard (credentials are on), fails startup naming the key', async () => {
      await expect(
        boot({}, { ...PRODUCTION, cors_allowed_origins: '' }),
      ).rejects.toThrow(/cors_allowed_origins/);
      await expect(
        boot({}, { ...PRODUCTION, cors_allowed_origins: '*' }),
      ).rejects.toThrow(/cors_allowed_origins/);
      expect(await boot({}, PRODUCTION)).toBeDefined();
    });

    it('S54 AS-135: outside production an empty allowlist reflects any origin', async () => {
      const res = await http(await boot({}, { cors_allowed_origins: '' }))
        .get('/t/ok')
        .set('Origin', 'https://anything.example')
        .expect(200);
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://anything.example',
      );
    });
  });

  describe('AS-136 / AS-137 client address', () => {
    it('S54 AS-136: behind a trusted proxy the first untrusted address from the right is the client; a forged leftmost value is ignored', async () => {
      const app = await boot({}, { trusted_proxies: '127.0.0.0/8,::1' });
      const res = await http(app)
        .get('/t/ip')
        .set('X-Forwarded-For', '6.6.6.6, 9.9.9.9, 127.0.0.1')
        .expect(200);
      expect(res.body).toEqual({ req: '9.9.9.9', ctx: '9.9.9.9' });
    });

    it('S54 AS-136: with trusted_proxies "none" the header is never believed', async () => {
      const res = await http(await boot({}, { trusted_proxies: 'none' }))
        .get('/t/ip')
        .set('X-Forwarded-For', '6.6.6.6')
        .expect(200);
      expect(res.body.req).toMatch(/127\.0\.0\.1|::1/);
    });

    it('S54 AS-137: production without a trusted-proxy setting fails startup; an explicit "none" starts', async () => {
      await expect(
        boot({}, { ...PRODUCTION, trusted_proxies: undefined }),
      ).rejects.toThrow(/trusted_proxies/);
      expect(
        await boot({}, { ...PRODUCTION, trusted_proxies: 'none' }),
      ).toBeDefined();
    });
  });

  it('S54 AS-138: handlers see the exact received bytes (an HMAC verifies); a body over 1 MiB is 413', async () => {
    const app = await boot();
    const body = '{"b": 1,   "a": 2}';
    const res = await http(app)
      .post('/t/raw')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(201);
    expect(res.body.hmac).toBe(
      createHmac('sha256', 'webhook-secret').update(body).digest('hex'),
    );
    expect(res.body.hmac).not.toBe(
      createHmac('sha256', 'webhook-secret')
        .update(JSON.stringify(JSON.parse(body)))
        .digest('hex'),
    );
    const within = JSON.stringify({ d: 'x'.repeat(1024 * 1024 - 20) });
    await http(app)
      .post('/t/raw')
      .set('Content-Type', 'application/json')
      .send(within)
      .expect(201);
    const over = JSON.stringify({ d: 'x'.repeat(1024 * 1024) });
    const rejected = await http(app)
      .post('/t/raw')
      .set('Content-Type', 'application/json')
      .send(over)
      .expect(413);
    expect(rejected.body.code).toBe('payload_too_large');
  });

  it('S54 AS-139: responses over 1 KiB are compressed when accepted; small, event-stream and no-transform responses never are', async () => {
    const app = await boot();
    const ask = (path: string) =>
      http(app).get(path).set('Accept-Encoding', 'gzip');
    const big = await ask('/t/big').expect(200);
    expect(big.headers['content-encoding']).toBe('gzip');
    expect(big.headers.vary).toMatch(/Accept-Encoding/);
    expect(
      (await ask('/t/small').expect(200)).headers['content-encoding'],
    ).toBeUndefined();
    expect(
      (await ask('/t/sse').expect(200)).headers['content-encoding'],
    ).toBeUndefined();
    expect(
      (await ask('/t/no-transform').expect(200)).headers['content-encoding'],
    ).toBeUndefined();
  });

  describe('AS-140 pipeline order and precedence', () => {
    const post = (
      app: INestApplication,
      headers: Record<string, string> = {},
      body: unknown = { name: 'ab', count: 'nope' },
    ) => {
      pipelineStages.length = 0;
      const r = http(app).post('/t/pipeline');
      for (const [k, v] of Object.entries(headers)) r.set(k, v);
      return r.send(body as object);
    };

    it('S54 AS-140: shed comes first, before CORS, authentication, rate limiting and validation', async () => {
      const source = new FakeLagSource();
      const app = await boot({}, { cors_allowed_origins: ORIGIN }, (b) =>
        b.overrideProvider(LAG_SOURCE).useValue(source),
      );
      source.emit(5_000);
      expect(app.get(EventLoopMonitor).p99Ms()).toBe(5_000);
      const res = await post(app, {
        Origin: 'https://evil.example',
        'x-user': 'u',
        'x-throttle': '1',
      }).expect(503);
      expect(res.body.code).toBe('service_overloaded');
      expect(pipelineStages).toEqual([]);
    });

    it('S54 AS-140: a disallowed origin with a bad body gets no CORS header and still reaches validation (400)', async () => {
      const app = await boot({}, { cors_allowed_origins: ORIGIN });
      const res = await post(app, {
        Origin: 'https://evil.example',
        'x-user': 'u',
      }).expect(400);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.body.code).toBe('validation_failed');
    });

    it('S54 AS-140: unauthenticated with a bad body is 401 - the guard runs before the pipe and the handler does not run', async () => {
      const res = await post(await boot()).expect(401);
      expect(res.body.code).toBe('unauthenticated');
      expect(pipelineStages).toEqual(['guards']);
    });

    it('S54 AS-140: authenticated, throttled and a bad body is 429 - the limiter runs before idempotency and validation', async () => {
      await post(await boot(), { 'x-user': 'u', 'x-throttle': '1' }).expect(
        429,
      );
      expect(pipelineStages).toEqual(['guards', 'metrics', 'rate-limit']);
    });

    it('S54 AS-140: authenticated with a bad body is 400 validation_failed', async () => {
      const res = await post(await boot(), { 'x-user': 'u' }).expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(pipelineStages).toEqual([
        'guards',
        'metrics',
        'rate-limit',
        'idempotency',
      ]);
    });

    it('S54 AS-140: a valid request passes guards, metrics, rate limit, idempotency, validation, handler in that order', async () => {
      await post(
        await boot(),
        { 'x-user': 'u' },
        { name: 'abc', count: 3 },
      ).expect(201);
      expect(pipelineStages).toEqual([
        'guards',
        'metrics',
        'rate-limit',
        'idempotency',
        'pipe',
        'handler',
      ]);
    });
  });

  describe('configuration reporting', () => {
    it('S54 AS-141: every invalid key is reported in one error, with its reason and without any value', () => {
      const utils = new ConfigUtilsService();
      const logs: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug'] as const)
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation(
            (...args: unknown[]) => void logs.push(JSON.stringify(args)),
          );
      let message = '';
      try {
        utils.parseSrc<Record<string, string>>(
          {
            port: { name: 'PORT', verify: joi.number().required() },
            db_port: { name: 'DB_PORT', verify: joi.number().required() },
            node_env: {
              name: 'NODE_ENV',
              verify: joi.string().valid('local', 'test').required(),
            },
            api_secret: {
              name: 'API_SECRET',
              verify: joi.string().min(64).required(),
            },
          },
          [
            {
              PORT: 'abc',
              DB_PORT: 'xyz',
              NODE_ENV: 'weird',
              API_SECRET: 's3cr3t-value',
            },
          ],
        );
      } catch (error) {
        message = (error as Error).message;
      }
      for (const key of ['port', 'db_port', 'node_env', 'api_secret'])
        expect(message).toContain(key);
      for (const value of ['abc', 'xyz', 'weird', 's3cr3t-value'])
        expect(message).not.toContain(value);
      expect(logs.join('\n')).not.toContain('s3cr3t-value');
    });

    it('S54 AS-152: the startup line names the loaded keys and marks secrets as [set], never printing a value', async () => {
      const lines: string[] = [];
      jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(
          (...args: unknown[]) => void lines.push(String(args[0])),
        );
      const config = new ApiConfigService(new ConfigUtilsService());
      await config.init();
      const startup = lines.find((line) =>
        line.startsWith('configuration loaded'),
      );
      expect(startup).toBeDefined();
      expect(startup).toContain('db_host');
      expect(startup).toMatch(/db_password=\[set\]/);
      for (const secretKey of ['db_password', 'stripe_secret_key'] as const) {
        const value = config.get(secretKey) as unknown as string | undefined;
        if (value) expect(startup).not.toContain(value);
      }
    });
  });
});
