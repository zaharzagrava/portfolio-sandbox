import 'reflect-metadata';

/**
 * Module-graph smoke check: loads every app's root module and walks Nest metadata without
 * bootstrapping anything (no DB, no network). A circular import between files (or barrels,
 * constitution X.4) leaves a class reference `undefined` at decoration time; tsc can't see it,
 * Nest only reports it on boot. This catches it without starting a server.
 *
 * Run: pnpm check:module-graph   (plain Node: Jest's runtime can't require the ESM-only deps)
 */
const ROOTS: Record<string, () => unknown> = {
  bff: () => require('../apps/bff/src/bff-app.module').BffAppModule,
  collab: () => require('../apps/collab/src/collab-app.module').CollabAppModule,
  core: () => require('../apps/core/src/core.module').CoreModule,
  'local-monolith': () => require('../apps/local-monolith/src/local-monolith.module').LocalMonolithModule,
  'payment-processor': () => require('../apps/payment-processor/src/payment-processor.module').PaymentProcessorModule,
  projector: () => require('../apps/projector/src/projector.module').ProjectorModule,
  'public-api': () => require('../apps/public-api/src/public-api-app.module').PublicApiAppModule,
  'sse-gateway': () => require('../apps/sse-gateway/src/sse-gateway.module').SseGatewayModule,
  worker: () => require('../apps/worker/src/worker.module').WorkerModule,
};

const KEYS = ['imports', 'providers', 'controllers', 'exports'] as const;

type Problem = string;

function walk(root: unknown): { problems: Problem[]; visited: number } {
  const problems: Problem[] = [];
  const seen = new Set<unknown>();
  const visitClass = (cls: unknown, where: string) => {
    if (typeof cls !== 'function' || seen.has(cls)) return;
    seen.add(cls);
    const params: unknown[] | undefined = Reflect.getMetadata('design:paramtypes', cls);
    params?.forEach((p, i) => {
      if (p === undefined) problems.push(`${where} › ${cls.name}: constructor param #${i} is undefined`);
    });
  };
  const visitModule = (mod: unknown, path: string) => {
    if (mod === undefined) {
      problems.push(`${path}: undefined module`);
      return;
    }
    if (mod instanceof Promise) return; // async dynamic module: resolved at boot
    const dynamic = mod && typeof mod === 'object' && 'module' in (mod as object) ? (mod as { module: unknown } & Record<string, unknown[]>) : null;
    const cls = dynamic ? dynamic.module : mod;
    if (typeof cls === 'object' && cls && 'forwardRef' in cls) return;
    if (seen.has(cls) && !dynamic) return;
    seen.add(cls);
    const name = (cls as { name?: string })?.name ?? '<anonymous>';
    for (const key of KEYS) {
      const fromMeta: unknown[] = Reflect.getMetadata(key, cls as object) ?? [];
      const fromDynamic: unknown[] = (dynamic?.[key] as unknown[]) ?? [];
      [...fromMeta, ...fromDynamic].forEach((entry, i) => {
        const at = `${path} › ${name}.${key}[${i}]`;
        if (entry === undefined) {
          problems.push(`${at}: undefined`);
          return;
        }
        if (key === 'imports') return visitModule(entry, `${path} › ${name}`);
        if (typeof entry === 'function') return visitClass(entry, at);
        if (typeof entry !== 'object' || entry === null) return; // string / symbol tokens
        const provider = entry as { useClass?: unknown; useExisting?: unknown };
        if ('useClass' in provider && provider.useClass === undefined) problems.push(`${at}: useClass undefined`);
        if (provider.useClass) visitClass(provider.useClass, at);
      });
    }
  };
  visitModule(root, '');
  return { problems, visited: seen.size };
}

/**
 * One child process per app: each app boots in a fresh process in production, and module load order decides
 * which side of a barrel cycle sees `undefined`. Loading all apps in one process hid a payment-processor boot
 * failure until Phase 3 (the cache was already warm from earlier apps).
 */
const only = process.argv[2];
if (only) {
  const { problems, visited } = walk(ROOTS[only]());
  console.log(`${problems.length ? '✗' : '✓'} ${only} (${visited} modules/classes)${problems.length ? '\n  ' + problems.join('\n  ') : ''}`);
  process.exitCode = problems.length ? 1 : 0;
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process');
  let failed = false;
  for (const app of Object.keys(ROOTS)) {
    const r = spawnSync(process.execPath, [...process.execArgv, __filename, app], { encoding: 'utf8', env: process.env });
    const out = (r.stdout as string).split('\n').filter((l) => /^[✓✗] |^  /.test(l)).join('\n');
    const line = out || `✗ ${app} (failed to load): ${((r.stderr as string).match(/^\w*(Error|Exception)[^\n]*/m) ?? ['crashed'])[0]}`;
    console.log(line);
    failed ||= line.startsWith('✗');
  }
  process.exit(failed ? 1 : 0);
}
