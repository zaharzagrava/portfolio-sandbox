import 'reflect-metadata';
import { Sequelize } from 'sequelize-typescript';

/**
 * Model-registry check (constitution IX.3, debt D-9): proves, without a database, that every app boots with a
 * complete Sequelize model set now that there's no central `ALL_MODELS` list.
 *
 * With `autoLoadModels`, @nestjs/sequelize collects every `SequelizeModule.forFeature([...])` model while module
 * files load, and adds them all to the connection at once. For each app this script:
 *   1. loads the app's root module (no bootstrap) and reads the collected set;
 *   2. calls `new Sequelize({ dialect: 'postgres', models })`, which initialises models and wires associations
 *      without connecting, so a missing association partner throws exactly as it would at boot.
 *
 * Each app runs in its own process (the collected set is global to the process).
 *
 * Run: pnpm check:model-registry
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  EntitiesMetadataStorage,
} = require('@nestjs/sequelize/dist/entities-metadata.storage');

const APPS: Record<string, [string, string]> = {
  bff: ['apps/bff/src/bff-app.module', 'BffAppModule'],
  collab: ['apps/collab/src/collab-app.module', 'CollabAppModule'],
  core: ['apps/core/src/core.module', 'CoreModule'],
  'local-monolith': [
    'apps/local-monolith/src/local-monolith.module',
    'LocalMonolithModule',
  ],
  'payment-processor': [
    'apps/payment-processor/src/payment-processor.module',
    'PaymentProcessorModule',
  ],
  projector: ['apps/projector/src/projector.module', 'ProjectorModule'],
  'public-api': [
    'apps/public-api/src/public-api-app.module',
    'PublicApiAppModule',
  ],
  'sse-gateway': [
    'apps/sse-gateway/src/sse-gateway.module',
    'SseGatewayModule',
  ],
  worker: ['apps/worker/src/worker.module', 'WorkerModule'],
  'e2e-harness': ['test/utils/global-modules', 'generateTestingModule'],
};

const app = process.argv[2];
if (app) {
  const [file, symbol] = APPS[app];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(require('node:path').resolve(__dirname, '..', file))[symbol];
  const models: Function[] =
    EntitiesMetadataStorage.getEntitiesByConnection('default') ?? [];
  try {
    new Sequelize({
      dialect: 'postgres',
      models: [...new Set(models)] as any,
      logging: false,
    });
    console.log(`✓ ${app} (${new Set(models).size} models)`);
  } catch (e) {
    console.log(
      `✗ ${app} (${new Set(models).size} models): ${(e as Error).message}`,
    );
    process.exitCode = 1;
  }
} else {
  // Driver: one child process per app.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process');
  let failed = false;
  for (const name of Object.keys(APPS)) {
    const r = spawnSync(
      process.execPath,
      [...process.execArgv, __filename, name],
      { encoding: 'utf8', env: process.env },
    );
    const line =
      (r.stdout as string).split('\n').find((l) => /^[✓✗] /.test(l)) ??
      `✗ ${name}: ${(r.stderr as string).split('\n').find((l) => /Error/.test(l)) ?? 'crashed'}`;
    console.log(line);
    failed ||= line.startsWith('✗');
  }
  process.exit(failed ? 1 : 0);
}
