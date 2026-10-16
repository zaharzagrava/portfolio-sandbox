import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import {
  CLOCK_MAX_ADVANCE_SECONDS,
  clockViewSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { CLOCK } from '@app/common/core/clock';
import { ConfigRules } from '@app/common/config/config-rules';
import '@app/common/config/clock-config';
import { ApiConfigModule } from '@app/common/config';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { waitFor } from '@app/test/utils/async-helpers';
import { ClockService } from '@app/infrastructure/clock';
import { IdentityOpsModule } from './identity-ops.module';
import { SessionIssuer } from './application/session-issuer.service';
import { Role } from './infra/models/user.model';
import { AuthTestApp, createAuthApp } from './testing/auth-app';

const KEY = 'clock:offsetSeconds';
const ROUTE = '/api/admin/clock';

const withControl = async (value: string | undefined) => {
  const before = process.env.CLOCK_CONTROL;
  if (value === undefined) delete process.env.CLOCK_CONTROL;
  else process.env.CLOCK_CONTROL = value;
  try {
    return await createAuthApp({ extraImports: [IdentityOpsModule] });
  } finally {
    if (before === undefined) delete process.env.CLOCK_CONTROL;
    else process.env.CLOCK_CONTROL = before;
  }
};

const token = async (t: AuthTestApp, role: Role) => {
  const user = await t.seedUser({ role });
  const session = await t.app
    .get(SessionIssuer)
    .issue({ userId: user.id, amr: ['pwd'] });
  return { Authorization: `Bearer ${session.accessToken.token}` };
};

describe('Controllable clock (S54, J01 G-32)', () => {
  describe('CLOCK_CONTROL unset', () => {
    let t: AuthTestApp;
    beforeAll(async () => {
      t = await withControl(undefined);
    });
    afterAll(() => t.close());

    it.each([['get'], ['put']] as const)(
      'J01 G-32: %s %s answers 404 when CLOCK_CONTROL is unset, even for an admin',
      async (method) => {
        const res = await t
          .http()
          [method](ROUTE)
          .set(await token(t, Role.ADMIN))
          .send(method === 'put' ? { advanceSeconds: 60 } : undefined)
          .expect(404);
        expect(problemDetailsSchema.parse(res.body).code).toBe('not_found');
        expect(
          await t.app.get(RedisService).client.exists(KEY),
        ).toBe(0);
      },
    );

    it('J01 G-32: the clock keeps the real time when the control is off', () => {
      const drift = Math.abs(t.app.get(ClockService).nowMs() - Date.now());
      expect(drift).toBeLessThan(50);
    });
  });

  describe('CLOCK_CONTROL=enabled', () => {
    let t: AuthTestApp;
    let admin: Record<string, string>;
    let redis: RedisService;
    let second: INestApplication;

    beforeAll(async () => {
      t = await withControl('enabled');
      redis = t.app.get(RedisService);
    });
    afterAll(async () => {
      await second?.close();
      await t.close();
    });
    beforeEach(async () => {
      await redis.client.del(KEY);
      admin = await token(t, Role.ADMIN);
    });

    const put = (body: unknown, headers = admin) =>
      t.http().put(ROUTE).set(headers).send(body as object);

    it('J01 G-32: 401 without a token and 403 for a non-admin', async () => {
      await t.http().get(ROUTE).expect(401);
      await t.http().put(ROUTE).send({ advanceSeconds: 60 }).expect(401);
      for (const role of [Role.USER, Role.SELLER]) {
        const headers = await token(t, role);
        await t.http().get(ROUTE).set(headers).expect(403);
        await put({ advanceSeconds: 60 }, headers).expect(403);
      }
      expect(await redis.client.exists(KEY)).toBe(0);
    });

    it('J01 G-32: GET shows the real clock before any advance', async () => {
      const res = await t.http().get(ROUTE).set(admin).expect(200);
      const view = clockViewSchema.parse(res.body);
      expect(view.mode).toBe('real');
      expect(view.offsetSeconds).toBe(0);
      expect(Math.abs(Date.parse(view.now) - Date.now())).toBeLessThan(2000);
    });

    it('J01 G-32: PUT advanceSeconds moves the time forward and persists the offset', async () => {
      const res = await put({ advanceSeconds: 3600 }).expect(200);
      const view = clockViewSchema.parse(res.body);
      expect(view.mode).toBe('offset');
      expect(view.offsetSeconds).toBe(3600);
      expect(Date.parse(view.now) - Date.now()).toBeGreaterThan(3590_000);
      expect(await redis.client.get(KEY)).toBe('3600');
      expect(t.app.get(ClockService).nowMs() - Date.now()).toBeGreaterThan(
        3590_000,
      );

      const again = clockViewSchema.parse(
        (await put({ advanceSeconds: 60 }).expect(200)).body,
      );
      expect(again.offsetSeconds).toBe(3660);
      expect(await redis.client.get(KEY)).toBe('3660');
    });

    it('J01 G-32: the largest step is accepted', async () => {
      const res = await put({
        advanceSeconds: CLOCK_MAX_ADVANCE_SECONDS,
      }).expect(200);
      expect(clockViewSchema.parse(res.body).offsetSeconds).toBe(
        CLOCK_MAX_ADVANCE_SECONDS,
      );
    });

    it.each([
      [{ advanceSeconds: 0 }],
      [{ advanceSeconds: -5 }],
      [{ advanceSeconds: CLOCK_MAX_ADVANCE_SECONDS + 1 }],
      [{ advanceSeconds: 1.5 }],
      [{ advanceSeconds: '60' }],
      [{}],
      [{ mode: 'offset' }],
      [{ advanceSeconds: 60, mode: 'real' }],
    ])('J01 G-32: %j is refused with 422 and changes nothing', async (body) => {
      const res = await put(body).expect(422);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'invalid_clock_update',
      );
      expect(await redis.client.exists(KEY)).toBe(0);
    });

    it('J01 G-32: PUT mode real clears the offset and is idempotent', async () => {
      await put({ advanceSeconds: 7200 }).expect(200);
      expect(await redis.client.exists(KEY)).toBe(1);

      for (let i = 0; i < 2; i++) {
        const res = await put({ mode: 'real' }).expect(200);
        const view = clockViewSchema.parse(res.body);
        expect(view.mode).toBe('real');
        expect(view.offsetSeconds).toBe(0);
        expect(await redis.client.exists(KEY)).toBe(0);
      }
      expect(
        Math.abs(t.app.get(ClockService).nowMs() - Date.now()),
      ).toBeLessThan(50);
    });

    it('J01 G-32: a second process sees the new time within 1 s and the reset too', async () => {
      process.env.CLOCK_CONTROL = 'enabled';
      try {
        const moduleRef = await Test.createTestingModule({
          imports: [ApiConfigModule, RedisModule, ClockModule],
        }).compile();
        second = moduleRef.createNestApplication({ bufferLogs: false });
        await second.init();
      } finally {
        delete process.env.CLOCK_CONTROL;
      }
      const other = second.get(ClockService);
      expect(other).not.toBe(t.app.get(ClockService));
      // every consumer of the CLOCK token (hold expiry, payout window, period close, job runAt) reads this service
      expect(second.get(CLOCK)).toBe(other);
      expect(Math.abs(other.nowMs() - Date.now())).toBeLessThan(50);

      await put({ advanceSeconds: 86_400 }).expect(200);
      await waitFor(
        async () => other.nowMs() - Date.now() > 86_390_000,
        { timeoutMs: 1000, intervalMs: 50 },
      );

      await put({ mode: 'real' }).expect(200);
      await waitFor(
        async () => Math.abs(other.nowMs() - Date.now()) < 50,
        { timeoutMs: 1000, intervalMs: 50 },
      );
    });
  });

  describe('production refusal', () => {
    it('J01 G-32: CLOCK_CONTROL=enabled with NODE_ENV=production fails config validation', () => {
      const violations = ConfigRules.validate(
        { clock_control: 'enabled' },
        { production: true },
      );
      expect(violations.filter((v) => v.startsWith('[clock]'))).toEqual([
        '[clock] clock_control must not be enabled in production',
      ]);
    });

    it('J01 G-32: enabled outside production, and disabled in production, are accepted', () => {
      const clockViolations = (value: string | undefined, production: boolean) =>
        ConfigRules.validate({ clock_control: value }, { production }).filter(
          (v) => v.startsWith('[clock]'),
        );
      expect(clockViolations('enabled', false)).toEqual([]);
      expect(clockViolations(undefined, true)).toEqual([]);
      expect(clockViolations('disabled', true)).toEqual([]);
    });
  });
});
