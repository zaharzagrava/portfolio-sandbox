import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import { ApiConfigService } from '@app/common/config';
import {
  MockApiConfigService,
  MockApiConfigServiceFactory,
} from '@app/common/config/api-config.service.mock';
import { ReadinessService } from '@app/infrastructure/health';
import { LlmModule } from '@app/infrastructure/llm';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { waitFor } from '@app/test/utils/async-helpers';
import { GenerationService } from './application/generation.service';
import { bootAssistant, data, type Harness } from './testing/assistant.harness';

const run = promisify(execFile);
const backend = join(__dirname, '../../..');

describe('Shopping assistant: configuration, shutdown, boundaries', () => {
  describe('S46 AS-74: invalid configuration fails startup naming the key', () => {
    const boot = (settings: Record<string, unknown>) =>
      generateTestingModule([LlmModule], {
        customize: (builder) =>
          builder.overrideProvider(ApiConfigService).useFactory({
            factory: async (utils: ConfigUtilsService) => {
              const config: MockApiConfigService =
                await MockApiConfigServiceFactory(utils);
              config.set('llm_provider', 'scripted');
              for (const [key, value] of Object.entries(settings))
                config.set(key as never, value);
              return config;
            },
            inject: [ConfigUtilsService],
          }),
      });

    it('a valid configuration boots', async () => {
      const module = await boot({});
      await module.close();
    });

    it.each([
      [
        'the real provider without an API key',
        { llm_provider: 'anthropic', anthropic_api_key: '' },
        'anthropic_api_key',
      ],
      [
        'no provider named and no key (never the scripted one)',
        { llm_provider: undefined, anthropic_api_key: undefined },
        'anthropic_api_key',
      ],
      [
        'the scripted provider in production',
        { node_env: 'production' },
        'llm_provider',
      ],
      [
        'an unpriced primary model',
        { assistant_model: 'claude-made-up-1' },
        'assistant_model',
      ],
      [
        'an unpriced fallback model',
        { assistant_fallback_model: 'claude-made-up-2' },
        'assistant_fallback_model',
      ],
      [
        'an unpriced summary model',
        { assistant_summary_model: 'claude-made-up-3' },
        'assistant_summary_model',
      ],
      [
        'a negative limit',
        { assistant_max_active_turns: -1 },
        'assistant_max_active_turns',
      ],
      [
        'a fractional timeout',
        { assistant_first_token_timeout_ms: 1.5 },
        'assistant_first_token_timeout_ms',
      ],
      [
        'a fallback equal to the primary when required',
        {
          assistant_require_distinct_fallback: true,
          assistant_fallback_model: 'claude-opus-5-5',
        },
        'assistant_fallback_model',
      ],
      [
        'a heartbeat above the proxy idle limit',
        { assistant_heartbeat_ms: 25_001 },
        'assistant_heartbeat_ms',
      ],
    ])('%s', async (_name, settings, key) => {
      await expect(boot(settings)).rejects.toThrow(key);
    });
  });

  describe('S46 AS-75: graceful shutdown', () => {
    let h: Harness;

    beforeAll(async () => {
      h = await bootAssistant();
    });
    afterAll(async () => {
      h.app.get(ReadinessService).resetShuttingDown();
      await h.close();
    });
    beforeEach(async () => {
      await h.reset();
    });

    it('fails readiness at once, refuses new sends, drains running replies, then aborts them with SHUTTING_DOWN', async () => {
      const u = await h.user();
      const [c1, c2, c3] = await Promise.all(
        [1, 2, 3].map(() => h.conversation(u)),
      );
      h.config.set('assistant_detach_grace_ms', 60_000);
      h.config.set('assistant_drain_ms', 1_000);
      h.llm.script(
        { text: 'one', hang: true, delayMs: 20 },
        { text: 'two', hang: true, delayMs: 20 },
      );
      const first = await h.ask(u, c1, { text: 'go' }, { count: 2 });
      const second = await h.ask(u, c2, { text: 'go' }, { count: 2 });
      const [g1, g2] = [first, second].map(
        (r) => data(r.events[0]).messageId as string,
      );
      const generations = h.app.get(GenerationService);
      expect(generations.localCount()).toBe(2);

      // SIGTERM: the readiness flag first, then the drain
      const readiness = h.app.get(ReadinessService);
      readiness.markShuttingDown();
      expect((await readiness.report()).ready).toBe(false);
      const refused = await h.ask(u, c3, { text: 'late' });
      expect([refused.status, refused.body.code]).toEqual([
        503,
        'assistant_unavailable',
      ]);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(await h.repository.messages(u.id, c3)).toHaveLength(0);

      const started = Date.now();
      const registry = h.app.get(ShutdownRegistry);
      expect(registry.listTaskNames()).toContain('assistant.generations');
      const result = await registry.run('drain');
      expect(result.failed).toEqual([]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);

      for (const g of [g1, g2]) {
        const events =
          (await h.generations.read(u.id, g, undefined, 10_000)) ?? [];
        const terminal = events.filter((e) =>
          ['done', 'error', 'refusal'].includes(e.event.type),
        );
        expect(terminal.map((e) => e.event)).toEqual([
          { type: 'error', data: { code: 'SHUTTING_DOWN' } },
        ]);
      }
      expect(h.llm.aborted).toBe(2);
      expect(await h.admission.slotMembers(u.id)).toEqual([]);
      expect(await h.admission.lockHolder(u.id, c1)).toBeNull();
      expect(await h.admission.lockHolder(u.id, c2)).toBeNull();
      expect(await h.repository.messages(u.id, c1)).toHaveLength(0);
      expect(generations.localCount()).toBe(0);
    });

    it('lets a reply that finishes within the drain period end normally', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.config.set('assistant_detach_grace_ms', 60_000);
      h.config.set('assistant_drain_ms', 5_000);
      h.app.get(ReadinessService).resetShuttingDown();
      const generations = h.app.get(GenerationService);
      (generations as unknown as { draining: boolean }).draining = false;
      h.llm.script({ text: 'quick answer', chunks: 3, delayMs: 200 });
      const first = await h.ask(u, c, { text: 'go' }, { count: 2 });
      const g = data(first.events[0]).messageId as string;

      await generations.drain();

      const events =
        (await h.generations.read(u.id, g, undefined, 10_000)) ?? [];
      expect(events.at(-1)!.event.type).toBe('done');
      await waitFor(
        async () => (await h.repository.messages(u.id, c)).length === 2,
        { description: 'turn persisted' },
      );
      (generations as unknown as { draining: boolean }).draining = false;
    });
  });

  describe('S46 AS-76: boundaries', () => {
    const sources = (dir: string) =>
      readdirSync(join(__dirname, dir))
        .filter(
          (f) =>
            f.endsWith('.ts') &&
            !f.endsWith('.spec.ts') &&
            !f.endsWith('-spec.ts'),
        )
        .map((f) => ({
          file: `${dir}/${f}`,
          text: readFileSync(join(__dirname, dir, f), 'utf8'),
        }));
    const shopping = (files: string[]) => (f: { file: string }) =>
      files.some((n) => f.file.endsWith(`/${n}`));

    it('api/ and application/ import no infra/ class and no other domain internals', () => {
      const own = [
        'allowance.service.ts',
        'assistant-errors.ts',
        'assistant-metrics.ts',
        'assistant-tools.ts',
        'assistant-turn.service.ts',
        'conversation.service.ts',
        'generation.service.ts',
        'metering.service.ts',
        'model-router.ts',
        'turn-runner.ts',
        'turn-log.ts',
        'assistant.controller.ts',
        'assistant-stream.ts',
        'zod.pipe.ts',
      ];
      const files = [...sources('application'), ...sources('api')].filter(
        shopping(own),
      );
      expect(files).toHaveLength(own.length);
      for (const { file, text } of files) {
        expect([file, /from '\.\.\/infra\//.test(text)]).toEqual([file, false]);
        expect([
          file,
          /@app\/domains\/[a-z-]+\/(infra|application|domain)\//.test(text),
        ]).toEqual([file, false]);
        expect([
          file,
          /UsageService|Model\b.*from '@app\/domains/.test(text),
        ]).toEqual([file, false]);
      }
    });

    it('domain/ files import no framework and read time only through the clock', () => {
      const own = [
        'admission.ts',
        'assistant-ports.ts',
        'compaction.ts',
        'conversation-cursor.ts',
        'generation-state.ts',
        'month.ts',
        'output-window.ts',
        'request-fingerprint.ts',
        'sensitive-data.ts',
        'stream-id.ts',
        'text-coalescer.ts',
      ];
      const files = sources('domain').filter(shopping(own));
      expect(files).toHaveLength(own.length);
      for (const { file, text } of files) {
        expect([
          file,
          /from '(@nestjs|ioredis|sequelize|cassandra-driver)/.test(text),
        ]).toEqual([file, false]);
        expect([file, /Date\.now\(|new Date\(\)/.test(text)]).toEqual([
          file,
          false,
        ]);
      }
    });

    it('dependency-cruiser and the table-ownership check are clean for this lib', async () => {
      const boundaries = await run('pnpm', ['run', 'check:boundaries'], {
        cwd: backend,
        timeout: 280_000,
      });
      expect(boundaries.stdout).toContain('no dependency violations found');

      // other domains still carry their own recorded findings; this lib and the LLM lib must have none
      const ownership = await run(
        'pnpm',
        ['run', 'check:table-ownership', '--strict'],
        { cwd: backend, timeout: 120_000 },
      )
        .then((r) => r.stdout)
        .catch((e: { stdout: string }) => e.stdout);
      expect(ownership).not.toContain('libs/domains/assistant/');
      expect(ownership).not.toContain('libs/infrastructure/llm/');
    }, 300_000);
  });
});
