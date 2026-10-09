import {
  CanActivate,
  Controller,
  Get,
  INestApplication,
  Injectable,
  Logger as NestLogger,
  Module,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { ApiConfigModule } from '@app/common/config';
import { LoggingModule } from '@app/common/logging/logging.module';
import { ClockModule } from '@app/infrastructure/platform';
import { RequestContextModule } from './request-context.module';
import { RequestContext } from './request-context.service';
import { createToolkitApp } from '@app/test/toolkit/test-app';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('request context (CTX)', () => {
  let app: INestApplication;
  let ctx: RequestContext;

  beforeAll(async () => {
    app = await createToolkitApp();
    await app.listen(0); // one shared server: 50 parallel supertest calls otherwise open 50 ephemeral ones
    ctx = app.get(RequestContext);
  });
  afterAll(async () => {
    await app.close();
  });

  it('S54 AS-17: a missing X-Request-Id gets a UUIDv7 in the header, the context and the error body', async () => {
    const ok = await request(app.getHttpServer()).get('/t/context').expect(200);
    expect(ok.headers['x-request-id']).toMatch(UUID_V7);
    expect(ok.body.requestId).toBe(ok.headers['x-request-id']);
    const err = await request(app.getHttpServer())
      .get('/t/app-error')
      .expect(400);
    expect(err.body.requestId).toBe(err.headers['x-request-id']);
  });

  it('S54 AS-18: an invalid inbound id is replaced, a valid one is kept', async () => {
    const kept = await request(app.getHttpServer())
      .get('/t/context')
      .set('x-request-id', 'client-id-12345')
      .expect(200);
    expect(kept.body.requestId).toBe('client-id-12345');
    const replaced = await request(app.getHttpServer())
      .get('/t/context')
      .set('x-request-id', 'short')
      .expect(200);
    expect(replaced.body.requestId).toMatch(UUID_V7);
  });

  it('S54 AS-19: 50 concurrent requests each read their own requestId after awaits', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `concurrent-request-${i}`);
    const results = await Promise.all(
      ids.map((id) =>
        request(app.getHttpServer())
          .get(`/t/delay/${(ids.indexOf(id) % 5) * 10}`)
          .set('x-request-id', id),
      ),
    );
    results.forEach((res, i) => expect(res.body.requestId).toBe(ids[i]));
  });

  it('S54 AS-21: shopId cannot change to a different value in one context; the same value is a no-op', async () => {
    await ctx.run({ requestId: 'ctx-test-0001' }, async () => {
      ctx.set('shopId', 'shop-a');
      expect(() => ctx.set('shopId', 'shop-a')).not.toThrow();
      expect(() => ctx.set('shopId', 'shop-b')).toThrow();
      expect(ctx.shopId).toBe('shop-a');
    });
  });

  it('S54 AS-22: run isolates contexts and is inactive afterwards', async () => {
    const [a, b] = await Promise.all([
      ctx.run({ requestId: 'ctx-run-aaaa1', userId: 'u1' }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return [ctx.requestId, ctx.userId];
      }),
      ctx.run({ requestId: 'ctx-run-bbbb1', userId: 'u2' }, async () => [
        ctx.requestId,
        ctx.userId,
      ]),
    ]);
    expect(a).toEqual(['ctx-run-aaaa1', 'u1']);
    expect(b).toEqual(['ctx-run-bbbb1', 'u2']);
    expect(ctx.isActive()).toBe(false);
  });

  it('S54 AS-23: reads outside a run return undefined and set is a no-op', () => {
    expect(ctx.requestId).toBeUndefined();
    expect(() => ctx.set('userId', 'x')).not.toThrow();
    expect(ctx.userId).toBeUndefined();
  });

  it('S54 AS-24: snapshot returns exactly the envelope fields as a copy', async () => {
    await ctx.run(
      {
        requestId: 'ctx-snap-0001',
        userId: 'u1',
        traceparent: '00-abc-def-01',
      },
      async () => {
        const snap = ctx.snapshot();
        expect(snap).toEqual({
          requestId: 'ctx-snap-0001',
          userId: 'u1',
          traceparent: '00-abc-def-01',
        });
        (snap as { userId?: string }).userId = 'tampered';
        expect(ctx.userId).toBe('u1');
      },
    );
  });

  it('S54 AS-25: memo runs the factory once per context and separately per context', async () => {
    let calls = 0;
    const factory = async () => ++calls;
    const first = await ctx.run({ requestId: 'ctx-memo-0001' }, async () => [
      await ctx.memo('k', factory),
      await ctx.memo('k', factory),
    ]);
    const second = await ctx.run({ requestId: 'ctx-memo-0002' }, async () =>
      ctx.memo('k', factory),
    );
    expect(first).toEqual([1, 1]);
    expect(second).toBe(2);
  });
});

/** Stand-ins for the platform's authentication and membership guards, and for a repository that reads the context. */
@Injectable()
class AuthGuard implements CanActivate {
  constructor(private readonly ctx: RequestContext) {}
  canActivate(): boolean {
    this.ctx.set('userId', 'user-20');
    this.ctx.set('principalType', 'user');
    return true;
  }
}
@Injectable()
class MembershipGuard implements CanActivate {
  constructor(private readonly ctx: RequestContext) {}
  canActivate(): boolean {
    this.ctx.set('shopId', 'shop-20');
    return true;
  }
}
@Injectable()
class ProductRepository {
  private readonly logger = new NestLogger('ProductRepository');
  constructor(private readonly ctx: RequestContext) {}
  findForCurrentShop() {
    this.logger.log('querying products');
    return {
      shopId: this.ctx.shopId,
      userId: this.ctx.userId,
      principalType: this.ctx.snapshot().principalType,
    };
  }
}
@Controller('c20')
class GuardedController {
  constructor(private readonly products: ProductRepository) {}
  @Get('products') @UseGuards(AuthGuard, MembershipGuard) list() {
    return this.products.findForCurrentShop();
  }
}
@Module({
  imports: [ApiConfigModule, ClockModule, RequestContextModule, LoggingModule],
  controllers: [GuardedController],
  providers: [ProductRepository, AuthGuard, MembershipGuard],
})
class GuardedContextModule {}

describe('request context set by guards (CTX)', () => {
  it('S54 AS-20: guard-set userId and shopId are visible to a repository call and on every later log line', async () => {
    const lines: string[] = [];
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });
    const moduleRef = await Test.createTestingModule({
      imports: [GuardedContextModule],
    }).compile();
    const app = moduleRef.createNestApplication({ bufferLogs: false });
    await app.init();
    app.useLogger(app.get(Logger));
    try {
      const res = await request(app.getHttpServer())
        .get('/c20/products')
        .expect(200);
      expect(res.body).toEqual({
        shopId: 'shop-20',
        userId: 'user-20',
        principalType: 'user',
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const logged = lines
        .join('')
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(logged.find((l) => l.msg === 'querying products')).toMatchObject({
        userId: 'user-20',
        shopId: 'shop-20',
        requestId: res.headers['x-request-id'],
      });
      expect(logged.find((l) => l.msg === 'request completed')).toMatchObject({
        userId: 'user-20',
        shopId: 'shop-20',
      });
    } finally {
      write.mockRestore();
      await app.close();
    }
  });
});
