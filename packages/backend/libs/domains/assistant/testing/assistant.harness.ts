import { INestApplication } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { v4 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import type { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { AuthApiModule } from '@app/domains/identity';
import { EntitlementsService } from '@app/domains/billing';
import { LLM_PROVIDER, ScriptedLlmProvider } from '@app/infrastructure/llm';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { issueSession } from '@app/test/seeds/session.fixture';
import { createUser } from '@app/test/utils/user-fixtures';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { readSse, type SseEvent } from '@app/test/utils/sse-client';
import { AssistantModule } from '../assistant.module';
import { ModelRouter } from '../application/model-router';
import {
  ADMISSION_STORE,
  CONVERSATION_REPOSITORY,
  GENERATION_STORE,
  type AdmissionStore,
  type ConversationRepository,
  type GenerationStore,
} from '../domain/assistant-ports';
import {
  MODERATION_BACKEND,
  type ModerationBackend,
} from '../infra/moderator.adapter';
import type { ModerationVerdict } from '../domain/ports';

export const TERMINAL = ['done', 'error', 'refusal'];
export const data = (e: SseEvent) => JSON.parse(e.data ?? '{}');
export const textOf = (events: SseEvent[]) =>
  events
    .filter((e) => e.event === 'text')
    .map((e) => data(e).t)
    .join('');

/** Billing at the system edge: the limit and the exact usage are set by the spec; either read can be made to fail. */
export class FakeEntitlements {
  limit = 1_000_000;
  billedUsage = 0;
  failGet = false;
  failUsage = false;
  usageReads = 0;

  reset() {
    this.limit = 1_000_000;
    this.billedUsage = 0;
    this.failGet = false;
    this.failUsage = false;
    this.usageReads = 0;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so that a failure is a rejection
  async get() {
    if (this.failGet) throw new Error('billing unreachable');
    return { assistantTokensPerMonth: this.limit };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so that a failure is a rejection
  async checkQuota(
    _type: string,
    _id: string,
    _key: string,
    now: Date = new Date(),
  ) {
    this.usageReads++;
    if (this.failUsage) throw new Error('usage unavailable');
    return {
      allowed: this.billedUsage < this.limit,
      used: this.billedUsage,
      limit: this.limit,
      resetsAt: new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      ).toISOString(),
    };
  }
}

/** The categorical moderation backend at the system edge: flags what the spec says to flag, or fails. */
export class FakeModerationBackend implements ModerationBackend {
  flagInput: ((text: string) => string | null) | null = null;
  flagOutput: ((text: string, context: string | null) => string | null) | null =
    null;
  fail = false;
  /** Fails only the output checks (the input was already accepted). */
  failOutput = false;
  stall = false;
  inputs: string[] = [];

  reset() {
    this.flagInput = null;
    this.flagOutput = null;
    this.fail = false;
    this.failOutput = false;
    this.stall = false;
    this.inputs = [];
  }

  async classify(
    text: string,
    context: string | null,
    options: { signal: AbortSignal },
  ): Promise<ModerationVerdict> {
    if (this.fail) throw new Error('moderation backend down');
    if (this.stall)
      await new Promise<void>((_, reject) =>
        options.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        ),
      );
    if (context === null) {
      this.inputs.push(text);
      const category = this.flagInput?.(text) ?? null;
      return category ? { flagged: true, category } : { flagged: false };
    }
    if (this.failOutput) throw new Error('moderation backend down');
    const category = this.flagOutput?.(text, context) ?? null;
    return category ? { flagged: true, category } : { flagged: false };
  }
}

export interface TestUser {
  id: string;
  email: string;
  auth: Record<string, string>;
}

export interface Harness {
  app: INestApplication;
  baseUrl: string;
  seeds: SeedsService;
  llm: ScriptedLlmProvider;
  redis: RedisService;
  config: MockApiConfigService;
  entitlements: FakeEntitlements;
  moderation: FakeModerationBackend;
  repository: ConversationRepository;
  generations: GenerationStore;
  admission: AdmissionStore;
  http: () => ReturnType<typeof request>;
  user(): Promise<TestUser>;
  conversation(u: TestUser, title?: string): Promise<string>;
  ask(
    u: TestUser,
    conversationId: string,
    body: object,
    opts?: AskOptions,
  ): ReturnType<typeof readSse>;
  /** Resets the per-test state; call from `beforeEach`. */
  reset(): Promise<void>;
  resetBudget(): Promise<void>;
  sessionFor(userId: string): Promise<Record<string, string>>;
  close(): Promise<void>;
}

export interface AskOptions {
  key?: string | null;
  count?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface BootOptions {
  /** Extra provider overrides on top of the standard ones. */
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  extraModules?: unknown[];
}

/**
 * The assistant against real Redis (generations, admission, counters), Scylla (transcript) and Postgres; the model is the
 * scripted provider, billing's entitlements and the categorical moderation backend are the system-edge fakes above.
 */
export async function bootAssistant(
  options: BootOptions = {},
): Promise<Harness> {
  const entitlements = new FakeEntitlements();
  const moderation = new FakeModerationBackend();
  const moduleRef = await generateTestingModule(
    [
      AssistantModule,
      AuthApiModule,
      SeedsModule,
      ...(options.extraModules ?? []),
    ],
    {
      stores: ['redis', 'cassandra'],
      customize: (builder) => {
        const base = builder
          .overrideProvider(EntitlementsService)
          .useValue(entitlements)
          .overrideProvider(MODERATION_BACKEND)
          .useValue(moderation);
        return options.customize ? options.customize(base) : base;
      },
    },
  );
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.listen(0);
  const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
  const redis = app.get(RedisService);
  const config = app.get(ApiConfigService) as MockApiConfigService;
  const llm = app.get<ScriptedLlmProvider>(LLM_PROVIDER);
  const http = () => request(app.getHttpServer());

  const user = async (): Promise<TestUser> => {
    const created = await createUser(app, { email: `a-${v4()}@mail.com` });
    const { bearer } = await issueSession(app, created);
    return {
      id: created.id,
      email: created.email,
      auth: { Authorization: bearer },
    };
  };

  const conversation = async (u: TestUser, title?: string) =>
    (
      await http()
        .post('/api/assistant/conversations')
        .set(u.auth)
        .send(title ? { title } : {})
        .expect(201)
    ).body.id as string;

  const ask = (
    u: TestUser,
    conversationId: string,
    body: object,
    opts: AskOptions = {},
  ) =>
    readSse(`${baseUrl}/assistant/conversations/${conversationId}/messages`, {
      method: 'POST',
      body,
      headers: {
        ...u.auth,
        ...(opts.key === null ? {} : { 'Idempotency-Key': opts.key ?? v4() }),
        ...opts.headers,
      },
      count: opts.count ?? 1_000,
      until: TERMINAL,
      timeoutMs: opts.timeoutMs ?? 10_000,
    });

  /** The fleet-wide provider budget is shared by every send of the suite; a spec that sends a lot refills it. */
  const resetBudget = async () => {
    for (const key of await redis.client.keys('rl:{llm.provider.tpm|*'))
      await redis.client.del(key);
  };

  /** A session of the same user on this app instance (sessions are per instance). */
  const sessionFor = async (userId: string) => {
    const { bearer } = await issueSession(app, { id: userId, role: 'USER' });
    return { Authorization: bearer };
  };

  const reset = async () => {
    await app.get(SeedsService).clean();
    llm.reset();
    config.reset();
    entitlements.reset();
    moderation.reset();
    await resetBudget();
    for (const key of await redis.client.keys('assistant:cooldown:*'))
      await redis.client.del(key);
    app.get(ModelRouter).resetBreakers();
  };

  return {
    app,
    baseUrl,
    seeds: app.get(SeedsService),
    llm,
    redis,
    config,
    entitlements,
    moderation,
    repository: app.get<ConversationRepository>(CONVERSATION_REPOSITORY),
    generations: app.get<GenerationStore>(GENERATION_STORE),
    admission: app.get<AdmissionStore>(ADMISSION_STORE),
    http,
    user,
    conversation,
    ask,
    reset,
    resetBudget,
    sessionFor,
    close: () => app.close(),
  };
}
