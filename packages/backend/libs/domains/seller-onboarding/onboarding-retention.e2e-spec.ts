import { v4 } from 'uuid';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { routeEnvelope } from '@app/infrastructure/projections/routing';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { JobsTestProbe } from '@app/infrastructure/jobs';
import { ShopDeleted } from '@app/domains/tenancy';
import { Role } from '@app/domains/identity';
import { OnboardingJobs } from './infra/onboarding.jobs';
import { OnboardingShopDeletedConsumer } from './infra/shop-deleted.consumer';
import {
  createOnboardingApp,
  type OnboardingTestApp,
  type Seller,
  type TestUser,
} from './testing/onboarding-app';

describe('Seller onboarding: retention (e2e)', () => {
  let t: OnboardingTestApp;
  let moderator: TestUser;
  let jobs: OnboardingJobs;
  let consumer: OnboardingShopDeletedConsumer;
  const probe = () => new JobsTestProbe(t.db);
  const day = 86_400_000;
  const document = async (id: string) =>
    (
      await t.rows<{
        storageKey: string;
        purgedAt: Date | null;
        status: string;
      }>(
        `SELECT "storageKey", "purgedAt", status FROM "ShopDocument" WHERE id = :id`,
        { id },
      )
    )[0];
  const present = async (id: string) =>
    (await t.storage.head((await document(id)).storageKey)) !== null;
  const count = async (table: string, shopId: string, column = '"shopId"') =>
    Number(
      (
        await t.rows<{ n: string }>(
          `SELECT count(*) AS n FROM "${table}" WHERE ${column} = :shopId`,
          { shopId },
        )
      )[0].n,
    );

  /** The way the projection runner hands a message to a consumer: route and validate, then `project`. */
  const deliver = async (envelope: EventEnvelope) => {
    const routed = routeEnvelope(
      consumer.handles,
      envelope,
      consumer.aggregateIdSchema,
    );
    if (routed.kind !== 'handle') return { delivered: false as const };
    try {
      await consumer.project([routed.envelope]);
    } catch (error) {
      if (error instanceof PermanentError) return { delivered: false as const }; // dead-lettered
      throw error;
    }
    return { delivered: true as const };
  };
  const shopDeleted = (shopId: string): EventEnvelope =>
    ShopDeleted.create(shopId, 3, { shopId, shopVersion: 3 });

  /** A verified shop with an approved registration, an approved statement and a superseded earlier statement. */
  const verifiedShop = async () => {
    const s = await t.submitted();
    const superseded = await t.upload(
      s,
      'BANK_STATEMENT',
      t.pdf('first statement'),
    );
    const reg = await t.approved(s, 'BUSINESS_REGISTRATION');
    const bank = await t.approved(s, 'BANK_STATEMENT'); // supersedes the first and verifies
    return { s, files: [superseded.id, reg, bank] };
  };

  beforeAll(async () => {
    t = await createOnboardingApp();
    jobs = t.app.get(OnboardingJobs);
    consumer = t.app.get(OnboardingShopDeletedConsumer, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.seeds.clean();
    t.llm.reset();
    jest.restoreAllMocks();
    moderator = await t.user(Role.MODERATOR);
  });

  describe('S04 AS-58: the purge of a round', () => {
    it('deletes the raw files of approved, rejected and superseded documents, keeps the sealed data, and is idempotent', async () => {
      const { s, files } = await verifiedShop();
      const [job] = await probe().find('onboarding.purge-documents', {
        shopId: s.shopId,
      });
      expect(job).toBeDefined();
      for (const id of files) expect(await present(id)).toBe(true);
      const extractionsBefore = await t.rows(
        `SELECT "documentId", attempt, "sealedFields", fields FROM "DocumentExtraction" WHERE "documentId" IN (:ids) ORDER BY 1, 2`,
        { ids: files },
      );

      await jobs.purge({ shopId: s.shopId, submissionNo: 1 });
      for (const id of files) {
        expect(await present(id)).toBe(false);
        expect((await document(id)).purgedAt).not.toBeNull();
      }
      expect(
        await t.rows(
          `SELECT "documentId", attempt, "sealedFields", fields FROM "DocumentExtraction" WHERE "documentId" IN (:ids) ORDER BY 1, 2`,
          { ids: files },
        ),
      ).toEqual(extractionsBefore);

      const purgedAt = (await document(files[1])).purgedAt;
      await jobs.purge({ shopId: s.shopId, submissionNo: 1 }); // again
      expect((await document(files[1])).purgedAt).toEqual(purgedAt);
    });

    it('an object that is already gone is not an error', async () => {
      const { s, files } = await verifiedShop();
      await t.storage.delete((await document(files[1])).storageKey);
      await jobs.purge({ shopId: s.shopId, submissionNo: 1 });
      expect((await document(files[1])).purgedAt).not.toBeNull();
    });

    it('a storage failure for one file fails the job, leaves that file unpurged and keeps the others purged; the retry completes', async () => {
      const { s, files } = await verifiedShop();
      const failing = (await document(files[1])).storageKey;
      const real = t.storage.delete.bind(t.storage);
      jest
        .spyOn(t.storage, 'delete')
        .mockImplementation((key: string) =>
          key === failing
            ? Promise.reject(new Error('storage unavailable'))
            : real(key),
        );
      await expect(
        jobs.purge({ shopId: s.shopId, submissionNo: 1 }),
      ).rejects.toThrow('1 of 3 raw files');
      expect((await document(files[1])).purgedAt).toBeNull();
      expect(await present(files[1])).toBe(true);
      expect((await document(files[0])).purgedAt).not.toBeNull();
      expect((await document(files[2])).purgedAt).not.toBeNull();

      jest.restoreAllMocks();
      await jobs.purge({ shopId: s.shopId, submissionNo: 1 });
      expect((await document(files[1])).purgedAt).not.toBeNull();
    });
  });

  it('S04 AS-59: rejecting the application schedules the purge 30 days later; a later round is not touched', async () => {
    const s = await t.submitted();
    const round1 = await t.needsReview(s);
    const res = await t
      .http()
      .post(`/api/admin/onboarding/reviews/${round1.taskId}/resolve`)
      .set(moderator.auth)
      .send({
        decision: 'REJECT_APPLICATION',
        reasonCode: 'DOCUMENTS_INVALID',
        reason: 'Documents are not valid',
      })
      .expect(200);
    expect(res.body.status).toBe('APPLICATION_REJECTED');
    const scheduled = await probe().find('onboarding.purge-documents', {
      shopId: s.shopId,
      submissionNo: 1,
    });
    expect(scheduled).toHaveLength(1);
    expect(
      new Date(scheduled[0].runAt).getTime() - t.clock.now().getTime(),
    ).toBeGreaterThan(29 * day);
    const [key] = await t.rows<{ idempotencyKey: string }>(
      `SELECT "idempotencyKey" FROM "Job" WHERE id = :id`,
      { id: scheduled[0].id },
    );
    expect(key.idempotencyKey).toBe(`purge:${s.shopId}:1`);

    // resubmit: round 2 with its own file
    await t
      .http()
      .put(`/api/shops/${s.shopId}/onboarding/steps/policies`)
      .set(s.auth)
      .send({ returnsDays: 30, shipsFrom: 'DE' })
      .expect(200);
    await t
      .http()
      .post(`/api/shops/${s.shopId}/onboarding/submit`)
      .set(s.auth)
      .expect(200);
    const round2 = await t.upload(
      s,
      'BANK_STATEMENT',
      t.pdf('round two statement'),
    );

    await jobs.purge({ shopId: s.shopId, submissionNo: 1 });
    expect(await present(round1.documentId)).toBe(false);
    expect((await document(round1.documentId)).status).toBe('SUPERSEDED');
    expect(await present(round2.id)).toBe(true);
    expect((await document(round2.id)).purgedAt).toBeNull();
  });

  describe('S04 AS-60: tenancy.shop_deleted', () => {
    it('deletes every raw file at once, cancels open tasks, schedules the erasure and has one effect per shop however often it is delivered', async () => {
      const s = await t.submitted();
      const queued = await t.upload(
        s,
        'BUSINESS_REGISTRATION',
        t.pdf('queued registration'),
      );
      const waiting = await t.needsReview(s);
      const event = shopDeleted(s.shopId);

      expect(await deliver(event)).toEqual({ delivered: true });
      expect(await deliver(event)).toEqual({ delivered: true }); // the same event again
      for (const id of [queued.id, waiting.documentId]) {
        expect(await present(id)).toBe(false);
        expect((await document(id)).purgedAt).not.toBeNull();
      }
      const [task] = await t.rows<{ status: string }>(
        `SELECT status FROM "ReviewTask" WHERE id = :id`,
        { id: waiting.taskId },
      );
      expect(task.status).toBe('CANCELLED');
      const erase = await probe().find('onboarding.erase-records', {
        shopId: s.shopId,
      });
      expect(erase).toHaveLength(1);
      // S49 schedules at most 366 days ahead: the first hop is a year on, the due time is in the payload
      const hop =
        (new Date(erase[0].runAt).getTime() - t.clock.now().getTime()) / day;
      expect(hop).toBeGreaterThan(364);
      expect(hop).toBeLessThan(366);
      const dueIn =
        (new Date((erase[0].payload as { dueAt: string }).dueAt).getTime() -
          t.clock.now().getTime()) /
        day;
      expect(dueIn).toBeGreaterThan(1824);
      expect(dueIn).toBeLessThan(1826);
      const [key] = await t.rows<{ idempotencyKey: string }>(
        `SELECT "idempotencyKey" FROM "Job" WHERE id = :id`,
        { id: erase[0].id },
      );
      expect(key.idempotencyKey).toBe(`erase:${s.shopId}`);
      // nothing is erased yet
      expect(await count('ShopOnboarding', s.shopId)).toBe(1);
    });

    it('an invalid payload is rejected before the consumer: no effect', async () => {
      const s = await t.submitted();
      const valid = shopDeleted(s.shopId);
      for (const payload of [
        { shopId: 'not-a-uuid', shopVersion: 1 },
        { shopVersion: 1 },
        { shopId: s.shopId },
        'text',
      ]) {
        expect(
          (await deliver({ ...valid, payload } as EventEnvelope)).delivered,
        ).toBe(false);
      }
      expect(
        await probe().find('onboarding.erase-records', { shopId: s.shopId }),
      ).toEqual([]);
    });

    it('a shop without onboarding data is a no-op', async () => {
      const unknown = v4();
      expect(await deliver(shopDeleted(unknown))).toEqual({ delivered: true });
      expect(
        await probe().find('onboarding.erase-records', { shopId: unknown }),
      ).toEqual([]);
    });

    it('a storage failure propagates so the message is redelivered; the retry finishes', async () => {
      const s: Seller = await t.submitted();
      const doc = await t.upload(s, 'BANK_STATEMENT', t.pdf('statement'));
      jest
        .spyOn(t.storage, 'delete')
        .mockRejectedValueOnce(new Error('storage unavailable'));
      await expect(deliver(shopDeleted(s.shopId))).rejects.toThrow('raw files');
      jest.restoreAllMocks();
      await deliver(shopDeleted(s.shopId));
      expect(await present(doc.id)).toBe(false);
      expect(
        await probe().find('onboarding.erase-records', { shopId: s.shopId }),
      ).toHaveLength(1);
    });
  });

  it('S04 AS-61: the erase job deletes every row of the shop - and nothing before it runs', async () => {
    const { s, files } = await verifiedShop();
    const other = await verifiedShop();
    await deliver(shopDeleted(s.shopId));
    const [job] = await probe().find('onboarding.erase-records', {
      shopId: s.shopId,
    });
    expect(job.status).toBe('QUEUED');
    const payload = job.payload as { shopId: string; dueAt: string };
    const rowsLeft = async () => ({
      application: await count('ShopOnboarding', s.shopId),
      documents: await count('ShopDocument', s.shopId),
      history: await count('OnboardingStatusHistory', s.shopId),
    });
    const before = await rowsLeft();
    expect(before.application).toBe(1);
    expect(before.documents).toBeGreaterThan(0);
    expect(before.history).toBeGreaterThan(0);

    // the first hop fires a year on: too early, nothing is deleted and the next hop is scheduled
    t.clock.advance(365 * day);
    await jobs.erase(payload);
    expect(await rowsLeft()).toEqual(before);
    expect(
      await probe().find('onboarding.erase-records', { shopId: s.shopId }),
    ).toHaveLength(2);

    t.clock.advance(1460 * day + 1_000); // past the due time
    await jobs.erase(payload); // the job runner at its due time
    await jobs.erase(payload); // twice is harmless
    for (const table of [
      'ShopOnboarding',
      'ShopDocument',
      'ReviewTask',
      'OnboardingStatusHistory',
    ])
      expect(await count(table, s.shopId)).toBe(0);
    expect(await count('DocumentExtraction', files[1], '"documentId"')).toBe(0);
    // another shop is untouched
    expect(await count('ShopOnboarding', other.s.shopId)).toBe(1);
    expect(
      await count('DocumentExtraction', other.files[1], '"documentId"'),
    ).toBeGreaterThan(0);
  });
});
