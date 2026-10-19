import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import {
  problemDetailsSchema,
  topicMessagePageSchema,
} from '@marketplace-sandbox/contracts';
import {
  createTopics,
  deleteTopicsMatching,
  testKafka,
} from '@app/test/utils/kafka-test';
import { IdentityOpsModule } from './identity-ops.module';
import { SessionIssuer } from './application/session-issuer.service';
import { Role } from './infra/models/user.model';
import { AuthTestApp, createAuthApp } from './testing/auth-app';

const RUN = uuidv4().slice(0, 8);
const TOPIC = `j03tap${RUN}.events`;
const route = (topic = TOPIC) => `/api/admin/topics/${topic}/messages`;

const withTap = async (value: string | undefined) => {
  const before = process.env.EVENT_TAP;
  if (value === undefined) delete process.env.EVENT_TAP;
  else process.env.EVENT_TAP = value;
  try {
    return await createAuthApp({ extraImports: [IdentityOpsModule] });
  } finally {
    if (before === undefined) delete process.env.EVENT_TAP;
    else process.env.EVENT_TAP = before;
  }
};

const token = async (t: AuthTestApp, role: Role) => {
  const user = await t.seedUser({ role });
  const session = await t.app
    .get(SessionIssuer)
    .issue({ userId: user.id, amr: ['pwd'] });
  return { Authorization: `Bearer ${session.accessToken.token}` };
};

const envelope = (type: string, aggregateId: string, n: number) => ({
  eventId: uuidv7(),
  type,
  version: 1,
  aggregateType: 'j03tap',
  aggregateId,
  aggregateVersion: n,
  occurredAt: new Date().toISOString(),
  payload: { n },
});

describe('Event tap (J03 G-41, S53)', () => {
  let t: AuthTestApp;
  let admin: Record<string, string>;
  const ids = { a: uuidv7(), b: uuidv7() };

  beforeAll(async () => {
    t = await withTap('enabled');
    await createTopics([{ topic: TOPIC }]);
    const producer = testKafka().producer();
    await producer.connect();
    await producer.send({
      topic: TOPIC,
      messages: [
        envelope('j03.thing_created', ids.a, 1),
        envelope('j03.thing_changed', ids.a, 2),
        envelope('j03.thing_created', ids.b, 1),
      ].map((e) => ({ key: e.aggregateId, value: JSON.stringify(e) })),
    });
    // A poison message is skipped, not served.
    await producer.send({
      topic: TOPIC,
      messages: [{ key: 'x', value: 'not json' }],
    });
    await producer.disconnect();
  }, 60_000);
  afterAll(async () => {
    await deleteTopicsMatching(new RegExp(`^j03tap${RUN}`));
    await t.close();
  });
  beforeEach(async () => {
    admin = await token(t, Role.ADMIN);
  });

  it('J03 G-41: an admin reads the relayed events of a topic, with key, version and payload', async () => {
    const res = await t.http().get(route()).set(admin).expect(200);
    const page = topicMessagePageSchema.parse(res.body);
    expect(page.items).toHaveLength(3);
    expect(page.items[0]).toMatchObject({
      type: 'j03.thing_created',
      key: ids.a,
      version: 1,
      payload: { n: 1 },
    });
  });

  it('J03 G-41: type and key filter the items; a filter that matches nothing is an empty page', async () => {
    const byType = topicMessagePageSchema.parse(
      (
        await t
          .http()
          .get(route())
          .query({ type: 'j03.thing_created' })
          .set(admin)
          .expect(200)
      ).body,
    );
    expect(byType.items.map((i) => i.key).sort()).toEqual(
      [ids.a, ids.b].sort(),
    );
    const byKey = topicMessagePageSchema.parse(
      (
        await t
          .http()
          .get(route())
          .query({ key: ids.a, type: 'j03.thing_changed' })
          .set(admin)
          .expect(200)
      ).body,
    );
    expect(byKey.items).toHaveLength(1);
    expect(byKey.items[0].version).toBe(2);
    const none = await t
      .http()
      .get(route())
      .query({ type: 'j03.never' })
      .set(admin)
      .expect(200);
    expect(none.body).toEqual({ items: [] });
  });

  it('J03 G-41: limit bounds the page, 200 at most; above that the request is refused', async () => {
    const one = topicMessagePageSchema.parse(
      (await t.http().get(route()).query({ limit: 1 }).set(admin).expect(200))
        .body,
    );
    expect(one.items).toHaveLength(1);
    const res = await t
      .http()
      .get(route())
      .query({ limit: 201 })
      .set(admin)
      .expect(422);
    expect(problemDetailsSchema.parse(res.body).status).toBe(422);
  });

  it('J03 G-41: a topic that does not exist is an empty page, and a topic name that is not one is refused', async () => {
    const missing = await t
      .http()
      .get(route(`j03tap${RUN}missing.events`))
      .set(admin)
      .expect(200);
    expect(missing.body).toEqual({ items: [] });
    await t.http().get(route('..%2Fsecret')).set(admin).expect(422);
  });

  it('J03 G-41: no token is 401; a user, seller or moderator is 403', async () => {
    await t.http().get(route()).expect(401);
    for (const role of [Role.USER, Role.SELLER, Role.MODERATOR])
      await t
        .http()
        .get(route())
        .set(await token(t, role))
        .expect(403);
  });

  it('J03 G-41: the tap is read-only: no write verb is routed', async () => {
    for (const method of ['post', 'put', 'delete'] as const)
      await t.http()[method](route()).set(admin).expect(405);
  });
});

describe('Event tap switched off (J03 G-41)', () => {
  let unset: AuthTestApp;
  let disabled: AuthTestApp;
  beforeAll(async () => {
    unset = await withTap(undefined);
    disabled = await withTap('disabled');
  }, 60_000);
  afterAll(async () => {
    await disabled.close();
    await unset.close();
  });

  it('J03 G-41: with EVENT_TAP unset or disabled the route does not exist (404), even for an admin', async () => {
    for (const off of [unset, disabled])
      await off
        .http()
        .get(route())
        .set(await token(off, Role.ADMIN))
        .expect(404);
  });
});
