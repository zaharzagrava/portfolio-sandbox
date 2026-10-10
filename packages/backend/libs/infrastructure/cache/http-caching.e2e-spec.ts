import { INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { AllExceptionsFilter } from '@app/common/exceptions-filter/exceptions-filter';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RequestContextModule } from '@app/infrastructure/context/request-context.module';
import { HealthModule } from '@app/infrastructure/health/health.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import {
  FixtureStore,
  fixtureDocSchema,
  HttpCachingFixtureModule,
} from './testing/http-caching-fixture';

@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    RequestContextModule,
    ErrorUtilsModule,
    HealthModule,
    HttpCachingFixtureModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
class HttpCachingTestModule {}

const A = { 'x-tenant': 'tenant-a' };
const B = { 'x-tenant': 'tenant-b' };
const invalidTags = () =>
  MetricsRegistry.value('cache_etag_invalid_total') ?? 0;
const HANDLER_HEADERS = [
  'cache-control',
  'cache-tag',
  'vary',
  'content-language',
  'content-location',
];

describe('HTTP caching (ETag, If-None-Match, Cache-Control)', () => {
  let app: INestApplication;
  let store: FixtureStore;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HttpCachingTestModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureHttpApp(app, {
      useStructuredLogger: false,
      processHandlers: false,
    });
    await app.init();
    store = app.get(FixtureStore);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    store.put({ id: 'p1', version: 3, tenant: 'tenant-a', title: 'First' });
  });

  describe('S52 AS-64: derive and revalidate', () => {
    it('S52 AS-64: a GET carries W/"p1-v3"; the repeat with it answers 304, empty, with every handler header repeated; a version bump gives 200 with the new tag', async () => {
      const first = await http().get('/api/fixture/docs/p1').set(A).expect(200);
      expect(first.headers.etag).toBe('W/"p1-v3"');
      expect(fixtureDocSchema.parse(first.body)).toMatchObject({
        id: 'p1',
        version: 3,
      });

      const repeat = await http()
        .get('/api/fixture/docs/p1')
        .set(A)
        .set('If-None-Match', 'W/"p1-v3"')
        .expect(304);
      expect(repeat.text).toBe('');
      expect(repeat.headers.etag).toBe('W/"p1-v3"');
      for (const header of HANDLER_HEADERS) {
        expect(repeat.headers[header]).toBeDefined();
        // `Vary` also carries the compression middleware’s Accept-Encoding on a full response; the handler’s part stays.
        if (header === 'vary')
          expect(repeat.headers.vary).toContain('Accept-Language');
        else expect(repeat.headers[header]).toBe(first.headers[header]);
      }
      expect(repeat.headers['content-type']).toBeUndefined();
      expect(repeat.headers['content-length']).toBeUndefined();
      expect(repeat.headers['content-encoding']).toBeUndefined();

      store.bump('p1');
      const updated = await http()
        .get('/api/fixture/docs/p1')
        .set(A)
        .set('If-None-Match', 'W/"p1-v3"')
        .expect(200);
      expect(updated.headers.etag).toBe('W/"p1-v4"');
      expect(fixtureDocSchema.parse(updated.body).version).toBe(4);
    });

    it('S52 AS-64: the handler’s own Cache-Control is never overwritten', async () => {
      const res = await http()
        .get('/api/fixture/own-cache-control/p1')
        .set(A)
        .expect(200);
      expect(res.headers['cache-control']).toBe('private, max-age=5');
      expect(res.headers.etag).toBe('W/"p1-v3"');
    });
  });

  describe('S52 AS-66: safe methods only', () => {
    it('S52 AS-66: HEAD returns the headers of GET without a body, and 304 when the validator matches', async () => {
      const get = await http().get('/api/fixture/docs/p1').set(A).expect(200);
      const head = await http().head('/api/fixture/docs/p1').set(A).expect(200);
      expect(head.text ?? '').toBe('');
      expect(head.headers.etag).toBe(get.headers.etag);
      for (const header of HANDLER_HEADERS)
        expect(head.headers[header]).toBeDefined();
      expect(head.headers['cache-control']).toBe(get.headers['cache-control']);

      const matched = await http()
        .head('/api/fixture/docs/p1')
        .set(A)
        .set('If-None-Match', get.headers.etag)
        .expect(304);
      expect(matched.headers.etag).toBe(get.headers.etag);
    });

    it.each([
      ['post', 201],
      ['put', 200],
      ['patch', 200],
      ['delete', 200],
    ] as const)(
      'S52 AS-66: %s with If-None-Match is never answered 304 and gets no ETag',
      async (method, status) => {
        for (const validator of [
          '*',
          'W/"p1-v1"',
          'W/"p1-v2"',
          'W/"p1-v3"',
          'W/"p1-v4"',
        ]) {
          const res = await http()
            [method]('/api/fixture/docs/p1')
            .set(A)
            .set('If-None-Match', validator)
            .send({});
          expect(res.status).toBe(status);
          expect(res.headers.etag).toBeUndefined();
          expect(res.body).toMatchObject({ id: 'p1' });
        }
      },
    );
  });

  describe('S52 AS-67: no validator on errors, no leak across tenants', () => {
    it('S52 AS-67: tenant B presenting tenant A’s validator (or *) gets 404 without ETag, never 304', async () => {
      for (const validator of ['W/"p1-v3"', '*']) {
        const res = await http()
          .get('/api/fixture/docs/p1')
          .set(B)
          .set('If-None-Match', validator);
        expect(res.status).toBe(404);
        expect(res.headers.etag).toBeUndefined();
      }
      await http()
        .get('/api/fixture/docs/p1')
        .set(A)
        .set('If-None-Match', 'W/"p1-v3"')
        .expect(304);
    });

    it.each([401, 403, 404, 500])(
      'S52 AS-67: a %s response has no ETag and is never 304',
      async (status) => {
        const res = await http()
          .get(`/api/fixture/errors/${status}`)
          .set('If-None-Match', '*');
        expect(res.status).toBe(status);
        expect(res.headers.etag).toBeUndefined();
      },
    );
  });

  describe('S52 AS-68: caller-supplied strong validator', () => {
    it('S52 AS-68: withEtag is emitted verbatim and conditional requests are evaluated against it', async () => {
      const first = await http().get('/api/fixture/story/s1').expect(200);
      expect(first.headers.etag).toBe('"story-1-v2-en"');
      expect(first.body).toEqual({ id: 's1', version: 2, locale: 'en' });

      await http()
        .get('/api/fixture/story/s1')
        .set('If-None-Match', '"story-1-v2-en"')
        .expect(304);
      await http()
        .get('/api/fixture/story/s1')
        .set('If-None-Match', 'W/"story-1-v2-en"')
        .expect(304);
      await http()
        .get('/api/fixture/story/s1')
        .set('If-None-Match', '"a", "story-1-v2-en"')
        .expect(304);
      const changed = await http()
        .get('/api/fixture/story/s1')
        .set('If-None-Match', '"story-1-v1-en"')
        .expect(200);
      expect(changed.headers.etag).toBe('"story-1-v2-en"');
    });

    it.each(['unquoted', 'long', 'control', 'space'])(
      'S52 AS-68: an invalid validator (%s) is not emitted, the response is 200 and the event is counted',
      async (kind) => {
        const before = invalidTags();
        const res = await http()
          .get(`/api/fixture/bad-validator/${kind}`)
          .set('If-None-Match', '*')
          .expect(200);
        expect(res.headers.etag).toBeUndefined();
        expect(res.body).toMatchObject({ id: 'story-1' });
        expect(invalidTags()).toBe(before + 1);
      },
    );
  });

  describe('S52 AS-69: no validator, no change', () => {
    it.each(['no-version', 'no-id', 'fractional-version', 'array', 'stream'])(
      'S52 AS-69: %s passes through untouched, even with If-None-Match: *',
      async (route) => {
        const res = await http()
          .get(`/api/fixture/${route}`)
          .set('If-None-Match', '*');
        expect(res.status).toBe(200);
        expect(res.headers.etag).toBeUndefined();
      },
    );
  });
});
