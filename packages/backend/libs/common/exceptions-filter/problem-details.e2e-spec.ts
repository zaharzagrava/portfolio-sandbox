import { INestApplication, Logger } from '@nestjs/common';
import {
  ProblemCatalogModule,
  problemCatalog,
} from '@app/common/errors/problem-catalog.module';
import { createValidationPipe } from './validation-pipe';
import request from 'supertest';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { ERROR_TRACKER } from '@app/common/errors/error-utils/error-tracker';
import { createToolkitApp } from '@app/test/toolkit/test-app';

describe('problem details (ERR)', () => {
  let app: INestApplication;
  const tracked: unknown[] = [];

  beforeAll(async () => {
    app = await createToolkitApp({
      customize: (b) =>
        b
          .overrideProvider(ERROR_TRACKER)
          .useValue({ capture: (e: unknown) => tracked.push(e) }),
      configureApp: (a) => {
        a.useGlobalPipes(createValidationPipe());
      },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    tracked.length = 0;
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it('S54 AS-01: carries every contract member and the header equals requestId', async () => {
    const res = await get('/t/app-error?x=1').expect(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(problemDetailsSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(res.body.instance).toBe('/t/app-error');
    expect(res.body).not.toHaveProperty('area');
    expect(res.body).not.toHaveProperty('supportTraceId');
  });

  it('S54 AS-02: a TypeError becomes 500 internal_error, no stack on the wire, tracker called once', async () => {
    const res = await get('/t/type-error').expect(500);
    expect(res.body.code).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toMatch(
      /TypeError|at Object|\.ts:\d+/,
    );
    expect(tracked).toHaveLength(1);
  });

  it('S54 AS-03: a 5xx wrapping internals returns the catalogue detail, not the message', async () => {
    const res = await get('/t/internal-with-secret').expect(500);
    expect(JSON.stringify(res.body)).not.toMatch(/relation|User|db\.internal/);
  });

  it('S54 AS-04: no debug members regardless of NODE_ENV', async () => {
    const original = process.env.NODE_ENV;
    try {
      for (const env of ['development', 'test', undefined]) {
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        const res = await get('/t/app-error').expect(400);
        for (const member of ['data', 'causes', 'stack', 'area'])
          expect(res.body).not.toHaveProperty(member);
      }
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('S54 AS-05: validation failure lists field errors, rejects unknown properties, echoes no value', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/validate')
      .send({ name: 'x', count: 'secret-value', extra: 1 })
      .expect(400);
    expect(res.body.code).toBe('validation_failed');
    const fields = (res.body.errors as { field: string; code: string }[]).map(
      (e) => e.field,
    );
    expect(fields).toEqual(expect.arrayContaining(['name', 'count', 'extra']));
    expect(JSON.stringify(res.body)).not.toContain('secret-value');
  });

  it('S54 AS-06: malformed JSON → 400 malformed_body', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/validate')
      .set('content-type', 'application/json')
      .send('{"name":')
      .expect(400);
    expect(res.body.code).toBe('malformed_body');
  });

  it('S54 AS-07: unmatched route → 404 not_found problem', async () => {
    const res = await get('/t/nope').expect(404);
    expect(res.body.code).toBe('not_found');
    expect(problemDetailsSchema.safeParse(res.body).success).toBe(true);
  });

  it('S54 AS-07: a wrong method on an existing path → 405 method_not_allowed with an Allow header', async () => {
    const res = await request(app.getHttpServer())
      .post('/t/ok')
      .send({})
      .expect(405);
    expect(res.body.code).toBe('method_not_allowed');
    expect(problemDetailsSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(String(res.headers.allow).split(/,\s*/)).toEqual(
      expect.arrayContaining(['GET', 'HEAD']),
    );
    expect(res.headers.allow).not.toContain('POST');
    // a path no route has stays a 404
    await request(app.getHttpServer()).post('/t/nope').send({}).expect(404);
  });

  it('S54 AS-06: oversize body → 413 payload_too_large, unsupported charset → 415', async () => {
    const big = await request(app.getHttpServer())
      .post('/t/validate')
      .send({ name: 'x'.repeat(300_000), count: 1 })
      .expect(413);
    expect(big.body.code).toBe('payload_too_large');
    const media = await request(app.getHttpServer())
      .post('/t/validate')
      .set('content-type', 'application/json; charset=iso-8859-1')
      .send('{}')
      .expect(415);
    expect(media.body.code).toBe('unsupported_media_type');
  });

  it('S54 AS-08: 401 keeps WWW-Authenticate, 403 leaks nothing', async () => {
    const r401 = await get('/t/unauthorized').expect(401);
    expect(r401.headers['www-authenticate']).toContain('Bearer');
    expect(r401.body.code).toBe('unauthenticated');
    const r403 = await get('/t/http-error/403').expect(403);
    expect(r403.body.code).toBe('forbidden');
    expect(JSON.stringify(r403.body)).not.toContain('http failure');
  });

  it('S54 AS-09: a raw unique violation → 409 conflict without column or value', async () => {
    const res = await get('/t/unique-violation').expect(409);
    expect(res.body.code).toBe('conflict');
    expect(JSON.stringify(res.body)).not.toMatch(
      /users_email_key|email|a@b\.c/,
    );
  });

  it('S54 AS-11: 4xx logs warn without stack, 5xx logs error with stack, requestId on every line', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      const r4 = await get('/t/app-error').expect(400);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`requestId: ${r4.body.requestId}`),
      );
      expect(error).not.toHaveBeenCalled();
      const r5 = await get('/t/type-error').expect(500);
      const call = error.mock.calls.find((c) =>
        String(c[0]).includes(r5.body.requestId),
      );
      expect(call).toBeDefined();
      expect(String(call?.[1])).toContain('TypeError');
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('S54 AS-12: a duplicate problem code with a different status fails startup naming both owners', () => {
    problemCatalog.clear();
    ProblemCatalogModule.forFeature([
      {
        code: 'dup_code',
        status: 409,
        title: 'T',
        detail: 'D',
        owner: 'orders',
      },
    ]);
    expect(() =>
      ProblemCatalogModule.forFeature([
        {
          code: 'dup_code',
          status: 422,
          title: 'T',
          detail: 'D',
          owner: 'billing',
        },
      ]),
    ).toThrow(/orders.*billing/);
    problemCatalog.clear();
  });

  it('S54 AS-14: @SensitivePathParams replaces the value with the route template in instance and logs', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      const res = await get('/t/secret/s3cr3t-value').expect(400);
      expect(res.body.instance).toBe('/t/secret/:token');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('s3cr3t-value');
    } finally {
      warn.mockRestore();
    }
  });

  it('S54 AS-13: an error after headers were sent does not write a second time or crash', async () => {
    await get('/t/headers-sent').catch(() => undefined);
    const res = await get('/t/ok').expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('S54 AS-15: every collected response parses with problemDetailsSchema', async () => {
    for (const path of [
      '/t/app-error',
      '/t/type-error',
      '/t/nope',
      '/t/http-error/403',
      '/t/http-error/401',
    ]) {
      const res = await get(path);
      expect(problemDetailsSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    }
  });
});
