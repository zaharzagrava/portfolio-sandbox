import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { waitFor } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { FlagsSdkModule } from './flags.module';
import { FlagsAdminModule } from './flags-admin.module';
import { FlagsClient, RULESET_KEY } from './infra/flags.client';
import {
  FlagsAdminService,
  FlagInput,
} from './application/flags-admin.service';

/** SD-38 against real Postgres + Redis: admin write → audit → published ruleset → pushed to the in-process SDK. */
describe('Feature flags (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let client: FlagsClient;
  let admin: FlagsAdminService;
  const actor = '00000000-0000-4000-8000-000000000001';

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [FlagsSdkModule, FlagsAdminModule, SeedsModule],
      { stores: ['redis'] },
    );
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    seeds = app.get(SeedsService);
    client = app.get(FlagsClient);
    admin = app.get(FlagsAdminService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    const redis = app.get(RedisService).client;
    await redis.del(RULESET_KEY);
    // The cleanup flushes Redis, which resets the version counter; in production it only ever grows, so
    // keep it ahead of what the long-lived client has already applied.
    await redis.set('flags:ruleset-version', client.version);
  });

  const rollout = (
    percent: number,
    extra: Partial<FlagInput> = {},
  ): FlagInput => ({
    enabled: true,
    variants: [
      { key: 'off', value: false },
      { key: 'on', value: true },
    ],
    defaultVariant: 'off',
    offVariant: 'off',
    bucketBy: 'userId',
    owner: 'checkout-team',
    rules: [
      {
        id: 'pct',
        conditions: [],
        rollout: [
          { variant: 'on', weight: percent * 100 },
          { variant: 'off', weight: 10_000 - percent * 100 },
        ],
      },
    ],
    ...extra,
  });

  it('a saved flag reaches the SDK by push; 50% rollout is ~half the users and sticky; the kill switch turns it off everywhere', async () => {
    const before = client.version;
    await admin.upsert('new-checkout', rollout(50), actor);
    await waitFor(async () => client.version > before, {
      description: 'ruleset pushed',
    });

    const users = Array.from({ length: 2_000 }, (_, i) => `u${i}`);
    const on = users.filter((u) =>
      client.isEnabled('new-checkout', { userId: u }),
    );
    expect(on.length / users.length).toBeGreaterThan(0.45);
    expect(on.length / users.length).toBeLessThan(0.55);
    expect(
      on.every((u) => client.isEnabled('new-checkout', { userId: u })),
    ).toBe(true);

    const v = client.version;
    await admin.kill('new-checkout', actor);
    await waitFor(async () => client.version > v);
    expect(
      users.some((u) => client.isEnabled('new-checkout', { userId: u })),
    ).toBe(false);

    const history = (await admin.history('new-checkout')) as {
      action: string;
    }[];
    expect(history.map((h) => h.action)).toEqual(['kill', 'create']);
  });

  it("invalid definitions are rejected; unknown flags fall back to the caller's default", async () => {
    await expect(
      admin.upsert('broken', rollout(50, { defaultVariant: 'nope' }), actor),
    ).rejects.toMatchObject({ status: 400 });
    expect(client.value('does-not-exist', { userId: 'u' }, 'fallback')).toBe(
      'fallback',
    );
  });

  it('GET /api/flags exposes only client-side flags, pre-evaluated, never the rules', async () => {
    await admin.upsert(
      'web-new-header',
      rollout(100, { clientSide: true }),
      actor,
    );
    await admin.upsert('server-only', rollout(100), actor);
    await waitFor(async () => client.isEnabled('server-only', { userId: 'x' }));

    const res = await request(app.getHttpServer())
      .get('/api/flags')
      .set('X-Anonymous-Id', 'anon-1')
      .expect(200);
    expect(res.body.flags).toEqual({ 'web-new-header': true });
    expect(JSON.stringify(res.body)).not.toContain('rollout');
  });

  it('stale report lists flags nobody evaluates and expired ones', async () => {
    await admin.upsert(
      'forgotten',
      rollout(0, { expiresAt: '2020-01-01T00:00:00Z' }),
      actor,
    );
    expect(
      ((await admin.stale()) as { key: string; expired: boolean }[]).find(
        (f) => f.key === 'forgotten',
      ),
    ).toMatchObject({ expired: true, evaluations: 0 });
  });
});
