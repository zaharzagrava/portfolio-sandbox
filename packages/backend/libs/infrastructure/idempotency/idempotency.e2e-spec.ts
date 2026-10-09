import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpException,
  Injectable,
  Module,
  Post,
  Get,
  Query,
  Param,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { IsString } from 'class-validator';
import type { Response } from 'express';
import request from 'supertest';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import {
  AppError,
  ErrorArea,
  Fatal_InternalServerError,
} from '@app/common/errors/error.types';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { AllExceptionsFilter } from '@app/common/exceptions-filter/exceptions-filter';
import { DatabaseModule } from '@app/infrastructure/database/database.module';
import { RequestContext } from '@app/infrastructure/context/request-context.service';
import { RequestContextModule } from '@app/infrastructure/context/request-context.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { stopConnection } from '@app/test/toolkit/stop-connection';
import { Idempotent, IdempotencyModule } from './index';
import { IdempotencyPurgeService } from './purge.service';

const calls: Record<string, number> = {};
const bump = (route: string) => (calls[route] = (calls[route] ?? 0) + 1);
let release: (() => void) | undefined;

class NameDto {
  @IsString() name!: string;
}

/** Stand-in for the platform's auth + throttling: sets the principal, or refuses before the interceptor runs. */
@Injectable()
class TestPrincipalGuard implements CanActivate {
  constructor(private readonly ctx: RequestContext) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.headers['x-throttle']) throw new HttpException('slow down', 429);
    if (req.headers['x-require-auth'] && !req.headers['x-user'])
      throw new HttpException('no credentials', 401);
    if (req.headers['x-user'])
      this.ctx.set('userId', String(req.headers['x-user']));
    if (req.headers['x-api-key'])
      req.apiKey = { id: String(req.headers['x-api-key']) };
    return true;
  }
}

@Controller('idem')
@UseGuards(TestPrincipalGuard)
class IdemController {
  @Post('create') @Idempotent() create(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const n = bump('create');
    res.setHeader('Location', `/things/${n}`);
    res.setHeader('Content-Type', 'application/vnd.test+json');
    res.setHeader('Set-Cookie', `sid=${n}; Path=/`);
    res.setHeader('ETag', `"v${n}"`);
    return { n, echo: body };
  }

  @Post('who') @Idempotent() who(@Res({ passthrough: true }) res: Response) {
    const n = bump('who');
    return {
      n,
      who: res.req.headers['x-user'] ?? res.req.headers['x-api-key'] ?? 'anon',
    };
  }

  @Post('shops/:id/deliveries') @Idempotent() deliveries(
    @Param('id') id: string,
    @Query() query: Record<string, string>,
  ) {
    return { n: bump(`deliveries:${id}`), query };
  }

  @Post('optional') @Idempotent({ required: false }) optional() {
    return { n: bump('optional') };
  }

  @Post('plain') plain() {
    return { n: bump('plain') };
  }

  @Get('get') @Idempotent() get() {
    return { n: bump('get') };
  }

  @Post('secure') @Idempotent() secure() {
    return { n: bump('secure') };
  }

  @Post('slow') @Idempotent() async slow() {
    const n = bump('slow');
    await new Promise((r) => setTimeout(r, 1000));
    return { n };
  }

  @Post('race') @Idempotent() async race() {
    const n = bump('race');
    await new Promise((r) => setTimeout(r, 400));
    return { n };
  }

  /** The first call parks until `release()` is called; later calls return at once. */
  @Post('parked') @Idempotent() async parked() {
    const n = bump('parked');
    if (n === 1) await new Promise<void>((r) => (release = r));
    return { n };
  }

  @Post('validated') @Idempotent() @UsePipes(new ValidationPipe()) validated(
    @Body() body: NameDto,
  ) {
    bump('validated');
    return body;
  }

  @Post('fail500') @Idempotent() fail500(): never {
    bump('fail500');
    throw new Fatal_InternalServerError();
  }

  @Post('fail409') @Idempotent() fail409(): never {
    bump('fail409');
    throw new AppError({
      code: 'stock_conflict',
      status: 409,
      title: 'Stock conflict',
      detail: 'Not enough stock',
      area: ErrorArea.DOMAIN,
    });
  }

  @Post('fail422') @Idempotent() fail422(): never {
    bump('fail422');
    throw new AppError({
      code: 'out_of_stock',
      status: 422,
      title: 'Out of stock',
      detail: 'Item is out of stock',
      area: ErrorArea.DOMAIN,
      idempotencyFinal: true,
    });
  }

  @Post('big') @Idempotent() big() {
    bump('big');
    return { data: 'x'.repeat(300 * 1024) };
  }
}

@Module({
  imports: [
    ApiConfigModule,
    DatabaseModule,
    ClockModule,
    RequestContextModule,
    ErrorUtilsModule,
    IdempotencyModule,
  ],
  controllers: [IdemController],
  providers: [
    TestPrincipalGuard,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class IdemTestModule {}

describe('idempotency (IDEM)', () => {
  const clock = new FakeClock(new Date('2026-03-01T10:00:00.000Z'));
  let app: INestApplication;
  let app2: INestApplication;
  let sequelize: Sequelize;
  let purge: IdempotencyPurgeService;
  let seq = 0;
  const key = (label = 'k') => `${label}-${Date.now()}-${++seq}`;

  const boot = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({
      imports: [IdemTestModule],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    const a = moduleRef.createNestApplication({ bufferLogs: false });
    await a.listen(0); // concurrent requests share one listening server instead of each opening (and closing) its own
    return a;
  };
  const post = (a: INestApplication, path: string, k?: string | string[]) => {
    const r = request(a.getHttpServer()).post(`/idem/${path}`);
    return k === undefined ? r : r.set('Idempotency-Key', k as string);
  };
  const rows = async (k: string) =>
    (await sequelize.query('select * from "IdempotencyKey" where key = $1', {
      bind: [k],
      type: 'SELECT',
    })) as Record<string, unknown>[];

  beforeAll(async () => {
    app = await boot();
    app2 = await boot();
    sequelize = app.get(Sequelize);
    purge = app.get(IdempotencyPurgeService);
    await sequelize.query('delete from "IdempotencyKey"');
  });
  afterAll(async () => {
    await app.close();
    await app2.close();
  });
  beforeEach(() => {
    for (const k of Object.keys(calls)) delete calls[k];
    release = undefined;
  });

  it('S54 AS-116: a new key runs the handler once and the replay returns the stored answer with Idempotency-Replayed', async () => {
    const k = key();
    const first = await post(app, 'create', k).send({ a: 1 }).expect(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    const second = await post(app, 'create', k).send({ a: 1 }).expect(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(calls.create).toBe(1);
    expect(await rows(k)).toHaveLength(1);
  });

  it('S54 AS-117: a replay keeps Location, Content-Type and ETag and drops Set-Cookie and Date', async () => {
    const k = key();
    const first = await post(app, 'create', k).send({}).expect(201);
    expect(first.headers['set-cookie']).toBeDefined();
    clock.advance(1000);
    const replay = await post(app, 'create', k).send({}).expect(201);
    expect(replay.headers.location).toBe(first.headers.location);
    expect(replay.headers['content-type']).toContain(
      'application/vnd.test+json',
    );
    expect(replay.headers.etag).toBe(first.headers.etag);
    expect(replay.headers['set-cookie']).toBeUndefined();
    const stored = (await rows(k))[0];
    expect(
      Object.keys(stored.response_headers as object)
        .map((h) => h.toLowerCase())
        .sort(),
    ).toEqual(['content-type', 'etag', 'location']);
  });

  it('S54 AS-118: 10 parallel same-key requests run the handler once, nine answer 409 idempotency_in_flight', async () => {
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post(app, 'slow', k).send({})),
    );
    expect(calls.slow).toBe(1);
    const busy = results.filter((r) => r.status === 409);
    expect(busy).toHaveLength(9);
    for (const r of busy) {
      expect(r.body.code).toBe('idempotency_in_flight');
      expect(r.headers['retry-after']).toBe('1');
    }
    const later = await post(app, 'slow', k).send({}).expect(201);
    expect(later.headers['idempotency-replayed']).toBe('true');
    expect(calls.slow).toBe(1);
  });

  it('S54 AS-119: a different body is 422 idempotency_key_reuse; reordered JSON keys replay', async () => {
    const k = key();
    await post(app, 'create', k)
      .send({ a: 1, b: { c: 2, d: 3 } })
      .expect(201);
    const reuse = await post(app, 'create', k).send({ a: 2 }).expect(422);
    expect(reuse.body.code).toBe('idempotency_key_reuse');
    const reordered = await post(app, 'create', k)
      .set('Content-Type', 'application/json')
      .send('{ "b": { "d": 3,   "c": 2 }, "a": 1 }')
      .expect(201);
    expect(reordered.headers['idempotency-replayed']).toBe('true');
    expect(calls.create).toBe(1);
  });

  it('S54 AS-120: the same key on another path or with another query is 422', async () => {
    const k = key();
    await request(app.getHttpServer())
      .post('/idem/shops/s1/deliveries')
      .set('Idempotency-Key', k)
      .send({})
      .expect(201);
    const otherPath = await request(app.getHttpServer())
      .post('/idem/shops/s2/deliveries')
      .set('Idempotency-Key', k)
      .send({})
      .expect(422);
    expect(otherPath.body.code).toBe('idempotency_key_reuse');
    const otherQuery = await request(app.getHttpServer())
      .post('/idem/shops/s1/deliveries?x=1')
      .set('Idempotency-Key', k)
      .send({})
      .expect(422);
    expect(otherQuery.body.code).toBe('idempotency_key_reuse');
    const k2 = key();
    await request(app.getHttpServer())
      .post('/idem/shops/s1/deliveries?b=2&a=1')
      .set('Idempotency-Key', k2)
      .send({})
      .expect(201);
    const sorted = await request(app.getHttpServer())
      .post('/idem/shops/s1/deliveries?a=1&b=2')
      .set('Idempotency-Key', k2)
      .send({})
      .expect(201);
    expect(sorted.headers['idempotency-replayed']).toBe('true');
  });

  it('S54 AS-121: key required, invalid forms rejected, ignored on GET and undeclared routes', async () => {
    const missing = await post(app, 'create').send({}).expect(422);
    expect(missing.body.code).toBe('idempotency_key_required');
    const invalid = ['abcdefg', 'a'.repeat(129), 'abcd efgh', 'abcdéfgh12'];
    for (const bad of invalid) {
      const res = await post(app, 'create', bad).send({}).expect(422);
      expect(res.body.code).toBe('idempotency_key_invalid');
    }
    const dup = await post(app, 'create', ['aaaaaaaa1', 'bbbbbbbb2'])
      .send({})
      .expect(422);
    expect(dup.body.code).toBe('idempotency_key_invalid');
    expect(calls.create).toBeUndefined();

    const k = key();
    await request(app.getHttpServer())
      .get('/idem/get')
      .set('Idempotency-Key', k)
      .expect(200);
    await request(app.getHttpServer())
      .get('/idem/get')
      .set('Idempotency-Key', k)
      .expect(200);
    expect(calls.get).toBe(2);
    await post(app, 'plain', 'x').send({}).expect(201);
    await post(app, 'plain', 'x').send({}).expect(201);
    expect(calls.plain).toBe(2);
    await post(app, 'optional').send({}).expect(201);
    expect(calls.optional).toBe(1);
    expect(await rows(k)).toHaveLength(0);
  });

  it('S54 AS-122: the scope is the principal - user, API key or client address - and replays never cross callers', async () => {
    const k = key();
    const asA = await post(app, 'who', k)
      .set('x-user', 'user-a')
      .send({})
      .expect(201);
    const asB = await post(app, 'who', k)
      .set('x-user', 'user-b')
      .send({})
      .expect(201);
    const asKey = await post(app, 'who', k)
      .set('x-api-key', 'key-1')
      .send({})
      .expect(201);
    const anon = await post(app, 'who', k).send({}).expect(201);
    expect(calls.who).toBe(4);
    expect([asA.body.who, asB.body.who, asKey.body.who, anon.body.who]).toEqual(
      ['user-a', 'user-b', 'key-1', 'anon'],
    );
    const replayB = await post(app, 'who', k)
      .set('x-user', 'user-b')
      .send({})
      .expect(201);
    expect(replayB.body).toEqual(asB.body);
    expect(replayB.headers['idempotency-replayed']).toBe('true');
    const scopes = (await rows(k)).map((r) => r.scope as string).sort();
    expect(scopes.filter((s) => s.startsWith('principal:'))).toEqual([
      'principal:key-1',
      'principal:user-a',
      'principal:user-b',
    ]);
    expect(scopes.filter((s) => s.startsWith('ip:'))).toHaveLength(1);
  });

  it('S54 AS-123: replayed at 23 h 59 min, treated as new after 24 h 1 s', async () => {
    const k = key();
    await post(app, 'create', k).send({}).expect(201);
    clock.advance((23 * 3600 + 59 * 60) * 1000);
    const replay = await post(app, 'create', k).send({}).expect(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(calls.create).toBe(1);
    clock.advance(2 * 60 * 1000);
    const fresh = await post(app, 'create', k).send({}).expect(201);
    expect(fresh.headers['idempotency-replayed']).toBeUndefined();
    expect(calls.create).toBe(2);
  });

  it('S54 AS-124: failures release the key unless the error is marked idempotencyFinal', async () => {
    const validation = key();
    await post(app, 'validated', validation).send({ name: 5 }).expect(400);
    await post(app, 'validated', validation).send({ name: 6 }).expect(400);
    expect(await rows(validation)).toHaveLength(0);

    const k500 = key();
    await post(app, 'fail500', k500).send({}).expect(500);
    await post(app, 'fail500', k500).send({}).expect(500);
    expect(calls.fail500).toBe(2);

    const k409 = key();
    await post(app, 'fail409', k409).send({}).expect(409);
    const again409 = await post(app, 'fail409', k409).send({}).expect(409);
    expect(again409.headers['idempotency-replayed']).toBeUndefined();
    expect(calls.fail409).toBe(2);

    const k422 = key();
    const first = await post(app, 'fail422', k422).send({}).expect(422);
    const replay = await post(app, 'fail422', k422).send({}).expect(422);
    expect(calls.fail422).toBe(1);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.code).toBe('out_of_stock');
    expect(replay.body.requestId).toBe(replay.headers['x-request-id']);
    expect(first.body.code).toBe('out_of_stock');
  });

  it('S54 AS-125: an expired lock is reclaimed, a live lock answers 409', async () => {
    const k = key();
    const firstCall = post(app, 'parked', k)
      .send({})
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 300));
    const live = await post(app2, 'parked', k).send({}).expect(409);
    expect(live.body.code).toBe('idempotency_in_flight');
    clock.advance(90_000);
    const takeover = await post(app2, 'parked', k).send({}).expect(201);
    expect(takeover.body.n).toBe(2);
    release?.();
    await firstCall;
    expect(calls.parked).toBe(2);
    const replay = await post(app, 'parked', k).send({}).expect(201);
    expect(replay.body.n).toBe(2);
    expect(replay.headers['idempotency-replayed']).toBe('true');
  });

  it('S54 AS-126: a response over 256 KiB is stored without a body and replays as 409 idempotency_replay_unavailable', async () => {
    const k = key();
    const first = await post(app, 'big', k).send({}).expect(201);
    expect(first.body.data).toHaveLength(300 * 1024);
    const stored = (await rows(k))[0];
    expect(stored.body_stored).toBe(false);
    expect(stored.response_body).toBeNull();
    const replay = await post(app, 'big', k).send({}).expect(409);
    expect(replay.body.code).toBe('idempotency_replay_unavailable');
    expect(calls.big).toBe(1);
  });

  it('S54 AS-127: with the store unreachable the request fails closed with 503 idempotency_unavailable and the handler does not run', async () => {
    const broken = await boot();
    await stopConnection(broken.get(Sequelize));
    const res = await post(broken, 'create', key()).send({}).expect(503);
    expect(res.body.code).toBe('idempotency_unavailable');
    expect(res.headers['retry-after']).toBe('1');
    expect(calls.create).toBeUndefined();
    await broken.close().catch(() => undefined);
  });

  it('S54 AS-128: unauthenticated and throttled requests claim no key, nor does an invalid header', async () => {
    const k = key();
    await post(app, 'secure', k)
      .set('x-require-auth', '1')
      .send({})
      .expect(401);
    await post(app, 'secure', k).set('x-throttle', '1').send({}).expect(429);
    await post(app, 'secure', 'short').set('x-user', 'u').send({}).expect(422);
    expect(await rows(k)).toHaveLength(0);
    expect((await rows('short')).length).toBe(0);
    expect(calls.secure).toBeUndefined();
  });

  it('S54 AS-129: the purge removes only records older than TTL + 1 h, in batches of at most 1 000, and a second run removes nothing', async () => {
    await sequelize.query('delete from "IdempotencyKey"');
    const now = clock.now();
    const insert = (label: string, count: number, expiresAt: Date) =>
      sequelize.query(
        `insert into "IdempotencyKey"(id, scope, key, fingerprint, state, claim_token, lock_expires_at, body_stored, created_at, expires_at)
         select gen_random_uuid(), 'principal:purge', $1 || g, repeat('a', 64), 'completed', gen_random_uuid(), $2, true, $2, $3 from generate_series(1, $4) g`,
        { bind: [label, now, expiresAt, count] },
      );
    await insert('old-', 1500, new Date(now.getTime() - 2 * 3600_000));
    await insert('grace-', 3, new Date(now.getTime() - 30 * 60_000));
    await insert('live-', 3, new Date(now.getTime() + 3600_000));
    expect(await purge.purgeBatch()).toBe(1000);
    expect(await purge.run()).toBe(500);
    expect(await purge.run()).toBe(0);
    const left = (await sequelize.query(
      'select count(*)::int as n from "IdempotencyKey"',
      { type: 'SELECT' },
    )) as { n: number }[];
    expect(left[0].n).toBe(6);
  });

  it('S54 AS-130: two instances on one database run the handler once for 20 concurrent requests with one key', async () => {
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        post(i % 2 === 0 ? app : app2, 'race', k).send({}),
      ),
    );
    expect(calls.race).toBe(1);
    const ok = results.filter((r) => r.status === 201);
    const busy = results.filter((r) => r.status === 409);
    expect(ok.length + busy.length).toBe(20);
    expect(
      ok.filter((r) => r.headers['idempotency-replayed'] !== 'true'),
    ).toHaveLength(1);
    expect(await rows(k)).toHaveLength(1);
  });
});
