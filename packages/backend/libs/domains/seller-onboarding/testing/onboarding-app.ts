import { Module, type INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { createHash } from 'node:crypto';
import { QueryTypes, type Sequelize } from 'sequelize';
import supertest from 'supertest';
import { v4 } from 'uuid';
import type { z } from 'zod';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { minimalPdf } from '@app/test/utils/minimal-pdf';
import { createUser } from '@app/test/utils/user-fixtures';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { issueSession } from '@app/test/seeds/session.fixture';
import { Role } from '@app/domains/identity';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { LLM_PROVIDER, ScriptedLlmProvider } from '@app/infrastructure/llm';
import { outboxRowsFor } from '@app/common/testing';
import {
  OnboardingExtractionModule,
  OnboardingModule,
  OnboardingProjectorModule,
  OnboardingWorkerModule,
} from '../onboarding.module';
import { OnboardingShopDeletedConsumer } from '../infra/shop-deleted.consumer';
import { ExtractionService } from '../application/extraction.service';
import type { DocumentKind } from '../domain/questionnaire';

@Module({
  imports: [
    OnboardingModule,
    OnboardingExtractionModule,
    OnboardingWorkerModule,
    OnboardingProjectorModule,
  ],
  // the projection framework builds this consumer in the projector app; the spec delivers to the same class
  providers: [OnboardingShopDeletedConsumer],
})
class SpecModule {}

/** Parses a response body with its contracts schema (VII.6, AS-68): fails with the issue list, never the values. */
export function expectContract<S extends z.ZodType>(
  schema: S,
  body: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new Error(
      `response does not match its contract: ${JSON.stringify(
        parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
        })),
      )}`,
    );
  return parsed.data;
}

export const ANSWERS = {
  business: {
    legalForm: 'LIMITED_COMPANY',
    businessName: 'Muller Handels',
    country: 'DE',
    registrationNumber: 'HRB 12345',
  },
  tax: { vatRegistered: false, vatNumber: null as string | null },
  catalog: {
    categories: ['Phones', 'Accessories'],
    expectedMonthlyOrders: 'UNDER_1000',
  },
  policies: { returnsDays: 30, shipsFrom: 'DE' },
};

export const WITH_VAT = {
  ...ANSWERS,
  tax: { vatRegistered: true, vatNumber: 'DE136695976' },
};

export const GOOD_IBAN = 'DE89 3704 0044 0532 0130 00';
export const BAD_IBAN = 'DE89 3704 0044 0532 0130 01';
const recent = () =>
  new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);

const f = (
  value: string | null,
  confidence: 'high' | 'medium' | 'low' = 'high',
) => ({ value, confidence, evidence: value });

/** What the scripted model answers for a business registration (matches `ANSWERS`). */
export const registrationAnswer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    documentType: 'BUSINESS_REGISTRATION',
    legible: true,
    fields: {
      legalName: f('Müller Handels GmbH'),
      registrationNumber: f('HRB12345'),
      country: f('DE'),
      registeredAddress: f('Hauptstr. 1, Berlin'),
      issueDate: f('2020-01-15'),
    },
    ...over,
  });

export const bankAnswer = (
  iban: string,
  confidence: 'high' | 'low' = 'high',
  holder = 'Müller Handels GmbH',
) =>
  JSON.stringify({
    documentType: 'BANK_STATEMENT',
    legible: true,
    fields: {
      accountHolder: f(holder),
      iban: f(iban, confidence),
      bankName: f('Commerzbank'),
      statementDate: f(recent()),
    },
  });

export const vatAnswer = (vatNumber = 'DE136695976') =>
  JSON.stringify({
    documentType: 'VAT_CERTIFICATE',
    legible: true,
    fields: {
      legalName: f('Müller Handels GmbH'),
      vatNumber: f(vatNumber),
      country: f('DE'),
    },
  });

export interface TestUser {
  id: string;
  auth: Record<string, string>;
  sessionId: string;
}
export interface Seller extends TestUser {
  shopId: string;
}

export interface OnboardingTestApp {
  app: INestApplication;
  clock: FakeClock;
  db: Sequelize;
  seeds: SeedsService;
  llm: ScriptedLlmProvider;
  extraction: ExtractionService;
  storage: ObjectStorage;
  http: () => ReturnType<typeof supertest>;
  user(role?: Role): Promise<TestUser>;
  /** A shop whose OWNER is the returned user. */
  seller(): Promise<Seller>;
  member(shopId: string, role: 'ADMIN' | 'STAFF' | 'VIEWER'): Promise<TestUser>;
  saveSteps(s: Seller, answers?: typeof ANSWERS): Promise<void>;
  /** Saves every step and submits (round 1). */
  submitted(answers?: typeof ANSWERS): Promise<Seller>;
  /** Requests a grant, plays the client PUT, confirms; returns the document ID. */
  upload(
    s: Seller,
    kind: DocumentKind,
    bytes: Buffer,
    contentType?: string,
  ): Promise<{ id: string; deduplicated: boolean }>;
  /** Uploads a file of the kind and lets the scripted model fail it twice, so it waits for a human. */
  needsReview(
    s: Seller,
    kind?: DocumentKind,
  ): Promise<{ documentId: string; taskId: string }>;
  /** Uploads a file of the kind and lets the scripted model read it correctly: the document ends `APPROVED`. */
  approved(s: Seller, kind: DocumentKind): Promise<string>;
  pdf(text: string): Buffer;
  outbox(aggregateId: string): ReturnType<typeof outboxRowsFor>;
  docStatus(id: string): Promise<string>;
  rows<T extends object>(
    sql: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * The real onboarding modules over real Postgres, Redis and object storage, with the production global pipe, filter and
 * prefix; only the clock is replaced (so specs can move time). The model is the scripted provider.
 */
export async function createOnboardingApp(): Promise<OnboardingTestApp> {
  const clock = new FakeClock(new Date());
  const moduleRef = await generateTestingModule([SpecModule, SeedsModule], {
    stores: ['redis', 'sqs', 'storage'],
    customize: (builder) => builder.overrideProvider(CLOCK).useValue(clock),
  });
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  configureHttpApp(app, { useStructuredLogger: false, processHandlers: false });
  await app.listen(0, '127.0.0.1');

  const db: Sequelize = app.get(getConnectionToken());
  const http = () => supertest(app.getHttpServer());
  const storage = app.get(ObjectStorage);

  const user: OnboardingTestApp['user'] = async (role = Role.USER) => {
    const created = await createUser(app, {
      email: `o-${v4()}@mail.com`,
      role,
    });
    const { bearer, sessionId } = await issueSession(app, created);
    return { id: created.id, auth: { Authorization: bearer }, sessionId };
  };

  const seller: OnboardingTestApp['seller'] = async () => {
    const owner = await user();
    const shop = await createShop(app, owner, { name: 'Müller Handels' });
    return { ...owner, shopId: shop.id as string };
  };

  const member: OnboardingTestApp['member'] = async (shopId, role) => {
    const created = await user();
    await addMember(app, shopId, created.id, role);
    return created;
  };

  const saveSteps: OnboardingTestApp['saveSteps'] = async (
    s,
    answers = ANSWERS,
  ) => {
    for (const [step, body] of Object.entries(answers))
      await http()
        .put(`/api/shops/${s.shopId}/onboarding/steps/${step}`)
        .set(s.auth)
        .send(body)
        .expect(200);
  };

  const submitted: OnboardingTestApp['submitted'] = async (answers) => {
    const s = await seller();
    await saveSteps(s, answers);
    const res = await http()
      .post(`/api/shops/${s.shopId}/onboarding/submit`)
      .set(s.auth);
    if (res.status !== 200)
      throw new Error(
        `submit answered ${res.status}: ${JSON.stringify(res.body)}`,
      );
    return s;
  };

  const rows = <T extends object>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => db.query<T>(sql, { type: QueryTypes.SELECT, replacements });

  const upload: OnboardingTestApp['upload'] = async (
    s,
    kind,
    bytes,
    contentType = 'application/pdf',
  ) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const res = await http()
      .post(`/api/shops/${s.shopId}/onboarding/documents`)
      .set(s.auth)
      .send({ kind, sha256, size: bytes.length, contentType });
    if (res.status !== 201 && res.status !== 200)
      throw new Error(
        `upload request answered ${res.status}: ${JSON.stringify(res.body)}`,
      );
    const [doc] = await rows<{ storageKey: string }>(
      `SELECT "storageKey" FROM "ShopDocument" WHERE id = :id`,
      { id: res.body.document.id },
    );
    if (res.body.upload && doc)
      await storage.put(doc.storageKey, bytes, contentType);
    await http()
      .post(
        `/api/shops/${s.shopId}/onboarding/documents/${res.body.document.id}/uploaded`,
      )
      .set(s.auth)
      .expect(200);
    return {
      id: res.body.document.id as string,
      deduplicated: res.body.deduplicated as boolean,
    };
  };

  const llm: ScriptedLlmProvider = app.get(LLM_PROVIDER);
  const extraction = app.get(ExtractionService);
  const good: Record<DocumentKind, () => string> = {
    BUSINESS_REGISTRATION: () => registrationAnswer(),
    BANK_STATEMENT: () => bankAnswer(GOOD_IBAN),
    VAT_CERTIFICATE: () => vatAnswer(),
  };
  const bad: Record<DocumentKind, () => string> = {
    BUSINESS_REGISTRATION: () =>
      registrationAnswer({
        fields: {
          ...JSON.parse(registrationAnswer()).fields,
          registrationNumber: {
            value: null,
            confidence: 'low',
            evidence: null,
          },
        },
      }),
    BANK_STATEMENT: () => bankAnswer(BAD_IBAN),
    VAT_CERTIFICATE: () => vatAnswer('DE136695975'),
  };

  const needsReview: OnboardingTestApp['needsReview'] = async (
    s,
    kind = 'BANK_STATEMENT',
  ) => {
    const doc = await upload(s, kind, minimalPdf([[`${kind} ${v4()}`, v4()]]));
    llm.script({ text: bad[kind]() }, { text: bad[kind]() });
    await extraction.process(doc.id);
    const [task] = await rows<{ id: string }>(
      `SELECT id FROM "ReviewTask" WHERE "documentId" = :id AND status = 'OPEN'`,
      { id: doc.id },
    );
    if (!task) throw new Error(`document ${doc.id} did not reach review`);
    return { documentId: doc.id, taskId: task.id };
  };

  const approved: OnboardingTestApp['approved'] = async (s, kind) => {
    const doc = await upload(s, kind, minimalPdf([[`${kind} ${v4()}`, v4()]]));
    llm.script({ text: good[kind]() });
    await extraction.process(doc.id);
    return doc.id;
  };

  return {
    app,
    clock,
    db,
    needsReview,
    approved,
    http,
    storage,
    seeds: app.get(SeedsService),
    llm,
    extraction,
    user,
    seller,
    member,
    saveSteps,
    submitted,
    upload,
    rows,
    pdf: (text) => minimalPdf([[text, v4()]]),
    outbox: (aggregateId) => outboxRowsFor(app, aggregateId),
    docStatus: async (id) =>
      (
        await rows<{ status: string }>(
          `SELECT status FROM "ShopDocument" WHERE id = :id`,
          { id },
        )
      )[0]!.status,
    close: () => app.close(),
  };
}
