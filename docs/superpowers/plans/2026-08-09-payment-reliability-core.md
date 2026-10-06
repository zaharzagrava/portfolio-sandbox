# Payment Reliability Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the backend into three Nest deployables sharing one library and build the outbox mailman, Stripe circuit breaker, and SSE status stream — the payment-reliability core from the design spec (Plan 1 of 4; OCC/refund, product search indexing, and edge/schema-registry work are separate follow-on plans).

**Architecture:** Convert `backend/` to genuine Nest CLI monorepo mode using Nest's own schematics, not a hand-rolled workaround. `nest generate app` relocates the existing project into `apps/api/src` (after renaming `package.json`'s `"name"` to `"api"` so it lands there instead of under the old name) and adds two new apps, `apps/worker` (Kafka consumer + Stripe + outbox mailman, no HTTP) and `apps/realtime` (SSE + a second Kafka consumer group, HTTP for SSE only). `nest generate library common` extracts genuinely cross-app code (models, config, auth, db-utils, error types, payment-dto) into `libs/common/src`, importable from any app via a `@app/common/*` path alias — one canonical copy of shared code, not three. Only the modules that become worker-exclusive (`payment`, `stripe`, `ledger`, `outbox`, `outbox-dto`, `kafka`, `cron`, `bis-utils`) physically move into `apps/worker/src`; everything api-only (`users`, `admin`, `product`, `elasticsearch`, `clickhouse`, etc.) just stays where Nest's relocation puts it, under `apps/api/src`.

**Tech Stack:** NestJS 11, Sequelize (sequelize-typescript), KafkaJS (already a dependency), `@nestjs/schedule` (already a dependency), Postgres, Redpanda (Kafka), Redis. New dependencies this plan adds: `opossum` (circuit breaker), `ioredis` (Redis pub/sub).

## Global Constraints

- **Commits happen per task, on `master`, no worktree.** This plan is executed via subagent-driven-development with the user's explicit sign-off to commit directly on `master` and to have each implementer subagent commit its own task. Each commit must stay scoped to that task's own files — sweeping in unrelated untracked/modified files (e.g. via `git add -A`) is a real defect to flag and fix.
- **Use Nest's own schematics (`nest generate app`, `nest generate library`) for the monorepo/library setup in Task 2 — do not hand-write `nest-cli.json` project entries or manually widen a `tsconfig.app.json`'s `rootDir`/`include` to reach across projects.** An earlier attempt at this plan tried the hand-rolled version; it produced fragile, non-standard config (duplicated compiled output, `deleteOutDir` conflicts between projects sharing one `dist/`) and is not to be repeated. Trust the schematic's own wiring; verify it works, don't second-guess its internals.
- Shared code lives in exactly one place: `libs/common/src`. Nothing under `apps/*/src` should ever be the only copy of something another app also needs — if two apps need it, it belongs in `libs/common`.
- Import shared code via the deep wildcard alias, e.g. `import { ApiConfigService } from '@app/common/api-config/api-config.service'` — not the bare barrel import (`from '@app/common'`). This is a deliberate choice (confirmed with the user) to keep import style close to today's `from 'src/...'` convention and avoid barrel-file name collisions as the library grows.
- All new/modified TypeScript must satisfy the existing `tsconfig.json` (`strictNullChecks: true`, `noImplicitAny: false`) — don't tighten or loosen these.
- Follow the existing codebase's conventions exactly: `AppError`/`ErrorArea` for all thrown errors (never a bare `Error` in application code), `@InjectModel` + a `<Entity>DtoService` for all DB access, `ApiConfigService.get('key')` for all config (never `process.env` directly outside `api-config`).
- Package manager is `yarn` (yarn.lock is the tracked lockfile, despite a stray `pnpm run` in one script) — use `yarn add`/`yarn add -D` for new dependencies.
- Run every command from `backend/` unless a step says otherwise.

---

## Task 1: Outbox schema migration — ALREADY COMPLETE

Done in an earlier pass (commit `45a45e5`, review clean): the `Outbox` table has `publishedAt`, `attempts`, `nextAttemptAt` columns plus a partial index, and `backend/src/models/outbox.model.ts` has the matching fields. Task 2 below physically relocates that same file (unchanged in content) to `libs/common/src/models/outbox.model.ts` as part of the monorepo conversion — no further schema work needed here.

---

## Task 2: Nest monorepo + shared library (apps/api, apps/worker, apps/realtime, libs/common)

**Files:**
- Modify: `backend/package.json` (`"name"` field, plus new scripts)
- Modify: `backend/nest-cli.json`, `backend/tsconfig.json` (both rewritten by Nest schematics; you only hand-edit the `paths` wildcard addition)
- Relocate (via `nest generate app`, not manual `git mv`): `backend/src/**` → `backend/apps/api/src/**`, `backend/test/**` → `backend/apps/api/test/**`
- Create (via `nest generate app`): `backend/apps/worker/src/**`, `backend/apps/realtime/src/**`
- Create (via `nest generate library common`): `backend/libs/common/src/**`
- Move (via `git mv`, after the above): shared modules from `apps/api/src/` into `libs/common/src/`
- Modify: every file under `apps/api/src/` that imports one of the moved modules (bulk find/replace)

**Interfaces:**
- Produces: `nest build api`, `nest build worker`, `nest build realtime` (exact command names to be confirmed in Step 3 — Nest may or may not require the app name once one is registered as default) all succeed; any file in any app can `import { X } from '@app/common/<path>'` to reach shared code.

- [ ] **Step 1: Rename the project so the relocated app lands at `apps/api`**

Edit `backend/package.json`'s `"name"` field from `"pay"` to `"api"`.

- [ ] **Step 2: Generate the two new apps**

Run: `npx nest generate app worker --skip-install`

Expected: Nest CLI detects this is the first `generate app` call in a non-monorepo project and converts it — it will relocate the **existing** `src/` and `test/` into `apps/api/src` and `apps/api/test` (using the `"name": "api"` from Step 1), create `apps/worker/src/{main.ts,app.module.ts,app.controller.ts,app.service.ts,app.controller.spec.ts}`, and rewrite `nest-cli.json` into monorepo form with a `"projects"` map containing both `api` and `worker`.

**Before proceeding, run `ls apps/api/src apps/worker/src` and confirm the relocation happened as described.** If instead nothing moved and `src/` is still at the root, stop and report BLOCKED — that means this Nest CLI version behaves differently than expected and the rest of this task's steps need re-deriving against what actually happened, not assumed.

Run: `npx nest generate app realtime --skip-install`

Expected: adds `realtime` to the same `"projects"` map, creates `apps/realtime/src/**`.

- [ ] **Step 3: Generate the shared library**

Run: `npx nest generate library common --skip-install`

Expected: creates `libs/common/src/{common.module.ts,common.service.ts,common.service.spec.ts,index.ts}`, adds a `libs/common/tsconfig.lib.json`, registers a `common` entry in `nest-cli.json`'s `"projects"` (type `"library"`), and adds a path mapping to root `tsconfig.json`'s `compilerOptions.paths` — check what it added: `cat tsconfig.json` and find the `"@app/common"` entry.

Delete the placeholder scaffolding, since this library holds relocated existing modules, not a new `CommonService`:

```bash
rm libs/common/src/common.module.ts libs/common/src/common.service.ts libs/common/src/common.service.spec.ts
```

Empty `libs/common/src/index.ts` (remove its `export * from './common.module'`/`export * from './common.service'` lines — leave the file present but with no exports; per this plan's Global Constraints, code is imported via the deep wildcard alias, not the barrel).

- [ ] **Step 4: Add the deep wildcard alias**

In root `tsconfig.json`, find the `"paths"` entry the generator added (something like `"@app/common": ["libs/common/src/index.ts"]`) and add a second entry alongside it so deep imports work:

```json
    "paths": {
      "@app/common": ["libs/common/src/index.ts"],
      "@app/common/*": ["libs/common/src/*"]
    }
```

(Merge this into whatever `compilerOptions` object is already there — don't duplicate the `compilerOptions` key.)

- [ ] **Step 5: Verify all three apps still build with just the schematic scaffolding**

Run: `npx nest build api` (or `npx nest build`, if that still resolves to `api` as the default project now that named projects exist — try both and note in your report which one works; use whichever succeeds for the rest of this task and update Step 8's package.json scripts to match)
Expected: succeeds.

Run: `npx nest build worker`
Expected: succeeds (placeholder `AppModule`/`AppController` only, nothing shared yet).

Run: `npx nest build realtime`
Expected: succeeds.

- [ ] **Step 6: Move shared modules into `libs/common/src`**

```bash
git mv apps/api/src/models libs/common/src/models
git mv apps/api/src/api-config libs/common/src/api-config
git mv apps/api/src/auth libs/common/src/auth
git mv apps/api/src/utils/db-utils libs/common/src/utils/db-utils
git mv apps/api/src/utils/error-utils libs/common/src/utils/error-utils
git mv apps/api/src/utils/config-utils libs/common/src/utils/config-utils
git mv apps/api/src/utils/user-utils libs/common/src/utils/user-utils
git mv apps/api/src/utils/custom-validators.ts libs/common/src/utils/custom-validators.ts
git mv apps/api/src/error.types.ts libs/common/src/error.types.ts
git mv apps/api/src/types.ts libs/common/src/types.ts
git mv apps/api/src/payment-dto libs/common/src/payment-dto
```

Everything else under `apps/api/src` (`users`, `users-dto`, `admin`, `aws-api`, `firebase`, `product`, `product-dto`, `elasticsearch`, `clickhouse`, `seeds`, `request`, `exceptions-filter`, `payment`, `payment-dto` — wait, `payment-dto` just moved above — `stripe`, `ledger`, `outbox`, `outbox-dto`, `kafka`, `cron`, `utils/bis-utils`, `utils/ts-node-utils`, `utils/test-utils`, `app.module.ts`, `app.controller.ts`, `app.service.ts`, `main.ts`) stays in `apps/api/src` for now — Task 3 moves the worker-exclusive subset of it into `apps/worker/src`.

- [ ] **Step 7: Bulk-replace shared-code imports across `apps/api/src`**

Every remaining file under `apps/api/src` that imports one of the moved modules via `from 'src/...'` needs that rewritten to `from '@app/common/...'`. Run this from `backend/`:

```bash
grep -rl "from 'src/\(models\|api-config\|auth\|error\.types\|types\|payment-dto\)" apps/api/src \
  | xargs sed -i \
      -e "s#from 'src/models#from '@app/common/models#g" \
      -e "s#from 'src/api-config#from '@app/common/api-config#g" \
      -e "s#from 'src/auth#from '@app/common/auth#g" \
      -e "s#from 'src/error\.types#from '@app/common/error.types#g" \
      -e "s#from 'src/types#from '@app/common/types#g" \
      -e "s#from 'src/payment-dto#from '@app/common/payment-dto#g"

grep -rl "from 'src/utils/\(db-utils\|error-utils\|config-utils\|user-utils\|custom-validators\)" apps/api/src \
  | xargs sed -i \
      -e "s#from 'src/utils/db-utils#from '@app/common/utils/db-utils#g" \
      -e "s#from 'src/utils/error-utils#from '@app/common/utils/error-utils#g" \
      -e "s#from 'src/utils/config-utils#from '@app/common/utils/config-utils#g" \
      -e "s#from 'src/utils/user-utils#from '@app/common/utils/user-utils#g" \
      -e "s#from 'src/utils/custom-validators#from '@app/common/utils/custom-validators#g"
```

Also check for `import type` variants and any `require`-style or dynamic-path references the two `grep`s above might have missed:

```bash
grep -rn "'src/\(models\|api-config\|auth\|error\.types\|types\|payment-dto\|utils/db-utils\|utils/error-utils\|utils/config-utils\|utils/user-utils\|utils/custom-validators\)" apps/api/src
```

Expected: no output (everything caught by the `sed` passes above). If something remains, it's a pattern the `sed` commands didn't match (e.g. `import type {...} from 'src/types'`) — fix it by hand the same way.

Also fix the one non-import reference: `apps/api/src/app.module.ts`'s `SequelizeModule.forRootAsync` currently has `models: [path.resolve(__dirname, './models')]` — since `models/` just moved out from under it, change this to point at the library's compiled location instead. Since you don't yet know the exact compiled path Nest's schematic produces (that depends on how the library gets bundled into the api build, which Step 9 will show you empirically), for now **delete this line and the `path` import if no longer used** — the app already uses `autoLoadModels: true` plus `SequelizeModule.forFeature([...])` in each feature module (confirmed already the codebase's actual working pattern — see e.g. `outbox-dto.module.ts`, `payment.module.ts`), so the directory-glob line is redundant with that mechanism, not load-bearing. If Step 9's build/boot reveals a model that's never registered via any `forFeature([...])` call anywhere (and thus was silently relying on the glob), add an explicit `SequelizeModule.forFeature([ThatModel])` to whichever module actually uses it instead of restoring the glob.

- [ ] **Step 8: Update `package.json` scripts**

Keep every existing script name working (adjust `"start"`, `"build"`, `"start:dev"`, etc. to explicitly target `api` if Step 5 found that necessary), and add:

```json
    "start:dev:worker": "NODE_ENV=local nest start worker --watch",
    "start:dev:realtime": "NODE_ENV=local nest start realtime --watch",
    "build:worker": "nest build worker",
    "build:realtime": "nest build realtime"
```

- [ ] **Step 9: Verify `api` builds and boots with the relocated + extracted code**

Run: `nest build api` (or whatever Step 5 determined is the right command)
Expected: succeeds, with no `Cannot find module '@app/common/...'` or `Cannot find module 'src/...'` errors.

With Docker infra up (`yarn docker` if not already running), run the api's dev-mode start command and confirm it boots without Sequelize model errors:

```bash
yarn start:dev
```
Expected: server starts listening, no unhandled model-association errors (this exercises whether every model relocated correctly and every `forFeature` registration still resolves it). Ctrl+C once confirmed.

- [ ] **Step 10: Verify worker and realtime can resolve `@app/common` too**

Add a one-line smoke check: temporarily edit `apps/worker/src/app.module.ts` to import anything from `@app/common` (e.g. `import { ApiConfigModule } from '@app/common/api-config/api-config.module';` added to its `imports` array), run `nest build worker`, confirm it compiles, then revert that temporary edit (Task 3 will wire worker's real module imports properly — this step only proves the alias resolves from a second app, not just from `api`).

- [ ] **Step 11: Stage only this task's files and commit**

Confirm `git status` shows only files this task actually touched (package.json, nest-cli.json, tsconfig.json, the relocated/moved paths under `apps/`, `libs/`) — the plan document and roadmap doc sitting in this working tree belong to neither this nor any other task; leave them completely untouched, do not `git add -A`.

- [ ] **Step 12: Stop — do not push, do not do anything beyond this task's own commit.** Move to Task 3.

---

## Task 3: Move worker-exclusive modules into `apps/worker`

**Files:**
- Move: `backend/apps/api/src/payment/**` → `backend/apps/worker/src/payment/**`
- Move: `backend/apps/api/src/stripe/**` → `backend/apps/worker/src/stripe/**`
- Move: `backend/apps/api/src/ledger/**` → `backend/apps/worker/src/ledger/**`
- Move: `backend/apps/api/src/outbox/**` → `backend/apps/worker/src/outbox/**`
- Move: `backend/apps/api/src/outbox-dto/**` → `backend/apps/worker/src/outbox-dto/**`
- Move: `backend/apps/api/src/kafka/**` → `backend/apps/worker/src/kafka/**`
- Move: `backend/apps/api/src/cron/**` → `backend/apps/worker/src/cron/**`
- Move: `backend/apps/api/src/utils/bis-utils/**` → `backend/apps/worker/src/utils/bis-utils/**`
- Modify: `backend/apps/worker/src/main.ts`, `backend/apps/worker/src/app.module.ts`
- Modify: `backend/apps/api/src/main.ts`, `backend/apps/api/src/app.module.ts`
- Delete: `backend/apps/worker/src/app.controller.ts`, `app.controller.spec.ts`, `app.service.ts` (placeholder scaffolding, no longer needed — worker has no HTTP)

**Interfaces:**
- Consumes (via `@app/common`, per Task 2): `ApiConfigService`, `DbUtilsService`, `PaymentDtoService` — payment-dto is shared, used by both api's reads and worker's write path.
- Produces: `apps/worker` runs the Kafka microservice (`payment-processor` consumer group) standalone; `apps/api` no longer runs any Kafka microservice.

- [ ] **Step 1: Move the eight directories**

```bash
git mv apps/api/src/payment apps/worker/src/payment
git mv apps/api/src/stripe apps/worker/src/stripe
git mv apps/api/src/ledger apps/worker/src/ledger
git mv apps/api/src/outbox apps/worker/src/outbox
git mv apps/api/src/outbox-dto apps/worker/src/outbox-dto
git mv apps/api/src/kafka apps/worker/src/kafka
git mv apps/api/src/cron apps/worker/src/cron
mkdir -p apps/worker/src/utils
git mv apps/api/src/utils/bis-utils apps/worker/src/utils/bis-utils
```

- [ ] **Step 2: Delete the worker app's placeholder scaffolding**

```bash
rm apps/worker/src/app.controller.ts apps/worker/src/app.controller.spec.ts apps/worker/src/app.service.ts
```

(Remove the earlier temporary `@app/common` smoke-test import from Task 2 Step 10 if it's still present in `apps/worker/src/app.module.ts` — you're about to rewrite that whole file anyway.)

- [ ] **Step 3: Rewrite `apps/worker/src/app.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ScheduleModule } from '@nestjs/schedule';
import { ApiConfigService } from '@app/common/api-config/api-config.service';
import { ApiConfigModule } from '@app/common/api-config/api-config.module';
import { Environment } from '@app/common/types';
import { PaymentModule } from './payment/payment.module';

@Module({
  imports: [
    ApiConfigModule,
    SequelizeModule.forRootAsync({
      imports: [ApiConfigModule],
      inject: [ApiConfigService],
      useFactory: (configService: ApiConfigService) => ({
        dialect: 'postgres',
        host: configService.get('db_host'),
        port: Number(configService.get('db_port')),
        username: configService.get('db_username'),
        password: configService.get('db_password'),
        database: configService.get('db_name'),
        autoLoadModels: true,
        synchronize: false,
        logging: false,
        ...(configService.get('node_env') === Environment.production && {
          dialectOptions: {
            ssl: { require: true, rejectUnauthorized: false },
          },
        }),
      }),
    }),
    ScheduleModule.forRoot(),
    PaymentModule,
  ],
})
export class WorkerAppModule {}
```

No `models: [path.resolve(...)]` directory glob here — same reasoning as Task 2 Step 7: `autoLoadModels: true` plus each feature module's own `SequelizeModule.forFeature([...])` is what actually registers models, and that pattern is preserved by every moved module (e.g. `payment.module.ts` already does `SequelizeModule.forFeature([Payment])`).

`ScheduleModule.forRoot()` is registered here even though nothing in this task uses it yet, because it initializes the `SchedulerRegistry` provider once at the root — Task 6's `CronService` (moved in Step 1 above) needs it, and this is the idiomatic place for it. `CronModule` itself is deliberately *not* imported here — it isn't needed until Task 6, where `OutboxModule` imports it directly (the module that actually uses it), rather than hoisting it to the root pre-emptively.

- [ ] **Step 4: Rewrite `apps/worker/src/main.ts`** (Kafka-only, no HTTP)

```typescript
import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from './app.module';
import { ApiConfigService } from '@app/common/api-config/api-config.service';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Environment } from '@app/common/types';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    bufferLogs: true,
  });

  const configService = app.get(ApiConfigService);

  const isLocalKafka = [Environment.local, Environment.test].includes(
    configService.get('node_env'),
  );

  const microservice = await NestFactory.createMicroservice<MicroserviceOptions>(
    WorkerAppModule,
    {
      transport: Transport.KAFKA,
      options: {
        client: {
          brokers: [configService.get('kafka_broker')],
          ...(isLocalKafka
            ? { retry: { retries: 0 } }
            : {
                ssl: true,
                sasl: {
                  mechanism: 'plain',
                  username: configService.get('kafka_api_key'),
                  password: configService.get('kafka_api_secret'),
                },
              }),
        },
        consumer: {
          groupId: 'payment-processor',
        },
      },
    },
  );

  microservice.enableShutdownHooks();
  await microservice.listen();
}

bootstrap();
```

Using `createMicroservice` directly (rather than `createApplicationContext` + `connectMicroservice`) is what gives worker no HTTP port at all, matching the design.

- [ ] **Step 5: Trim `apps/worker/src/payment/payment.module.ts`** — remove `FirebaseModule`, `AuthModule`, `UserUtilsModule`, `UsersDtoModule` imports (they were only needed by the `GET` endpoints, which Task 4 moves out of worker):

```typescript
import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/api-config/api-config.module';
import { DbUtilsModule } from '@app/common/utils/db-utils/db-utils.module';
import { PaymentDtoModule } from '@app/common/payment-dto/payment-dto.module';
import Payment from '@app/common/models/payment.model';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { StripeModule } from '../stripe/stripe.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { BisUtilsModule } from '../utils/bis-utils/bis-utils.module';

@Module({
  imports: [
    SequelizeModule.forFeature([Payment]),
    ApiConfigModule,
    DbUtilsModule,
    BisUtilsModule,
    PaymentDtoModule,
    StripeModule,
    LedgerModule,
    OutboxModule,
  ],
  providers: [PaymentService],
  exports: [PaymentService],
  controllers: [PaymentController],
})
export class PaymentModule {}
```

- [ ] **Step 6: Update every other moved file's shared-code imports**

The eight moved directories (`payment`, `stripe`, `ledger`, `outbox`, `outbox-dto`, `kafka`, `cron`, `utils/bis-utils`) still have `from 'src/...'` imports pointing at now-relocated shared code. Run the same bulk replace as Task 2 Step 7, scoped to worker's new location:

```bash
grep -rl "from 'src/\(models\|api-config\|auth\|error\.types\|types\|payment-dto\)" apps/worker/src \
  | xargs sed -i \
      -e "s#from 'src/models#from '@app/common/models#g" \
      -e "s#from 'src/api-config#from '@app/common/api-config#g" \
      -e "s#from 'src/auth#from '@app/common/auth#g" \
      -e "s#from 'src/error\.types#from '@app/common/error.types#g" \
      -e "s#from 'src/types#from '@app/common/types#g" \
      -e "s#from 'src/payment-dto#from '@app/common/payment-dto#g"

grep -rl "from 'src/utils/\(db-utils\|error-utils\|config-utils\|user-utils\|custom-validators\)" apps/worker/src \
  | xargs sed -i \
      -e "s#from 'src/utils/db-utils#from '@app/common/utils/db-utils#g" \
      -e "s#from 'src/utils/error-utils#from '@app/common/utils/error-utils#g" \
      -e "s#from 'src/utils/config-utils#from '@app/common/utils/config-utils#g" \
      -e "s#from 'src/utils/user-utils#from '@app/common/utils/user-utils#g" \
      -e "s#from 'src/utils/custom-validators#from '@app/common/utils/custom-validators#g"

grep -rn "'src/" apps/worker/src
```

The last command should show nothing left unhandled. Also check for any relative imports between the moved directories that assumed a different depth after the move (e.g. `outbox/outbox.service.ts` importing `outbox-dto` — confirm the relative path `../outbox-dto/outbox-dto.service` still resolves correctly given both now sit as siblings under `apps/worker/src/`, same relative structure as they had as siblings under `apps/api/src/` before, so these should already be correct without changes — just confirm via the build in Step 8, not by manual inspection).

- [ ] **Step 7: Remove the Kafka microservice bootstrap and unused imports from `apps/api/src/main.ts`**

Delete the `app.connectMicroservice<MicroserviceOptions>({...})` block (the whole call, including the `isLocalKafka` variable it uses) and `await app.startAllMicroservices();`, and remove the now-unused `import { MicroserviceOptions, Transport } from '@nestjs/microservices';` line. `apps/api/src/main.ts` should still call `app.listen(configService.get('port'))` as before — api keeps its HTTP server, it just no longer also runs a Kafka consumer.

- [ ] **Step 8: Remove `PaymentModule` from `apps/api/src/app.module.ts`**

Delete the `import { PaymentModule } from './payment/payment.module';` line and the `PaymentModule,` entry in the `imports` array. (Task 4 adds its replacement.)

- [ ] **Step 9: Verify worker builds and boots against real infra**

Ensure Docker infra is up (`yarn docker` in another terminal if not already running), then:

Run: `yarn build:worker`
Expected: succeeds with no missing-module errors.

Run: `yarn kafka:topics:init` (if not already done) then `yarn start:dev:worker`
Expected: logs show the Nest microservice starting and subscribing to `payments.requests` under group `payment-processor`, no crash.

- [ ] **Step 10: End-to-end regression check — the existing payment flow must still work with worker as the only consumer**

With `yarn start:dev:worker` running, produce a test message onto `payments.requests` the same way the edge worker would (a JSON payload matching `PostPaymentParamsDto`: `idempotency_key`, `amount`, `bisOrderId`, `paymentMethodId`). Use the Redpanda console UI at `http://localhost:8080` (Topics → `payments.requests` → Produce) or:

```bash
docker exec -it payment_system_kafka rpk topic produce payments.requests --key "test-idem-key-1"
```
then paste a JSON body (single line) matching an existing seeded `bisOrderId`/user and press Ctrl+D.

Expected: worker's logs show `PaymentConsumer.handlePayment` processing the message, Stripe being called (or the `is_load_test` stub path), and a `Payment` row created in Postgres with status `COMPLETED` or `FAILED`. Confirm via:

```bash
docker exec -it payment_system_db psql -U "$DB_USERNAME" -d "$DB_NAME" -c 'SELECT id, "idempotencyKey", status FROM "Payment" ORDER BY "createdAt" DESC LIMIT 1;'
```

- [ ] **Step 11: Stage only this task's files and commit.** Move to Task 4.

---

## Task 4: Split payment reads into `apps/api`

**Files:**
- Create: `backend/apps/api/src/payment-query/payment-query.module.ts`, `backend/apps/api/src/payment-query/payment-query.service.ts`, `backend/apps/api/src/payment-query/payment-query.controller.ts`, `backend/apps/api/src/payment-query/types.ts`
- Modify: `backend/apps/worker/src/payment/payment.controller.ts` (drop the two `GET` handlers)
- Modify: `backend/apps/worker/src/payment/payment.service.ts` (drop `getPayment`/`listPayments`)
- Modify: `backend/apps/api/src/app.module.ts` (register `PaymentQueryModule`)

**Interfaces:**
- Consumes: `PaymentDtoService` (`@app/common/payment-dto`), `UserUtilsService.getUser(request)` (`@app/common/utils/user-utils`), `@Firewall()` (`@app/common/auth/decorators/firewall.decorator`).
- Produces: `GET /payment/:id`, `GET /payment` — identical routes/behavior to before, now served by `apps/api`.

- [ ] **Step 1: Create `payment-query.service.ts`**

```typescript
import { Injectable } from '@nestjs/common';
import { DbUtilsService } from '@app/common/utils/db-utils/db-utils.service';
import { PaymentDtoService } from '@app/common/payment-dto/payment-dto.service';
import { UserRawDto } from '../users/types';
import { ListPaymentsResponseDto, PaymentRawDto } from './types';

@Injectable()
export class PaymentQueryService {
  constructor(
    private readonly dbUtilsService: DbUtilsService,
    private readonly paymentDtoService: PaymentDtoService,
  ) {}

  public async getPayment({
    id,
    viewerUser,
  }: {
    id: string;
    viewerUser: UserRawDto;
  }): Promise<PaymentRawDto> {
    return await this.dbUtilsService.wrapInTransaction(async (tx) => {
      return await this.paymentDtoService.requestPayment({
        params: { id, userId: viewerUser.id },
        tx,
      });
    });
  }

  public async listPayments({
    viewerUser,
  }: {
    viewerUser: UserRawDto;
  }): Promise<ListPaymentsResponseDto> {
    return await this.dbUtilsService.wrapInTransaction(async (tx) => {
      const payments = await this.paymentDtoService.requestPayments({
        params: { userId: viewerUser?.id },
        tx,
      });

      return { payments };
    });
  }
}
```

The `UserRawDto` import above is a plain relative import (from `apps/api/src/payment-query/` up to `apps/api/src/users/`) — not a `@app/common` alias — because `users`/`users-dto` are api-only and were never moved into `libs/common` (only genuinely cross-app code lives there).

- [ ] **Step 2: Create `payment-query/types.ts`**

Copy `PaymentRawDto`, `PaymentFullDto`, and `ListPaymentsResponseDto` verbatim from `apps/worker/src/payment/types.ts` into `apps/api/src/payment-query/types.ts` (same class bodies; update their imports to `@app/common/...` per Task 3 Step 6's replacement pattern). Leave the originals in `apps/worker/src/payment/types.ts` too — `PostPaymentParamsDto`/`PostPaymentResponseDto`/`Domain_StripePaymentFailed` there are still used by worker's Kafka handler, and a little type duplication between the two apps is the accepted trade-off from not putting api-only DTOs in the shared library.

- [ ] **Step 3: Create `payment-query.controller.ts`**

```typescript
import { Controller, Get, Param, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall } from '@app/common/auth/decorators/firewall.decorator';
import type { RequestWithUser } from '@app/common/types';
import { UserUtilsService } from '@app/common/utils/user-utils/user-utils.service';
import { PaymentQueryService } from './payment-query.service';

@ApiTags('payment')
@Controller('payment')
export class PaymentQueryController {
  constructor(
    private readonly paymentQueryService: PaymentQueryService,
    private readonly userUtilsService: UserUtilsService,
  ) {}

  @Firewall()
  @Get('/:id')
  async get(@Param('id') id: string, @Request() request: RequestWithUser) {
    const viewerUser = this.userUtilsService.getUser(request);
    return await this.paymentQueryService.getPayment({ id, viewerUser });
  }

  @Firewall()
  @Get('/')
  async list(@Request() request: RequestWithUser) {
    const viewerUser = this.userUtilsService.getUser(request);
    return await this.paymentQueryService.listPayments({ viewerUser });
  }
}
```

- [ ] **Step 4: Create `payment-query.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { AuthModule } from '@app/common/auth/auth.module';
import { DbUtilsModule } from '@app/common/utils/db-utils/db-utils.module';
import { UserUtilsModule } from '@app/common/utils/user-utils/user-utils.module';
import { PaymentDtoModule } from '@app/common/payment-dto/payment-dto.module';
import { PaymentQueryService } from './payment-query.service';
import { PaymentQueryController } from './payment-query.controller';

@Module({
  imports: [AuthModule, DbUtilsModule, UserUtilsModule, PaymentDtoModule],
  providers: [PaymentQueryService],
  controllers: [PaymentQueryController],
})
export class PaymentQueryModule {}
```

- [ ] **Step 5: Register it in `apps/api/src/app.module.ts`**

Add `import { PaymentQueryModule } from './payment-query/payment-query.module';` and `PaymentQueryModule,` in the `imports` array (same place `PaymentModule` used to be, per Task 3 Step 8).

- [ ] **Step 6: Trim `apps/worker/src/payment/payment.controller.ts`** to the Kafka handler only:

```typescript
import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  Payload,
} from '@nestjs/microservices';
import { OutboxService } from '../outbox/outbox.service';
import { KafkaTopicGroup } from '@app/common/models/outbox.model';
import { KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { PaymentService } from './payment.service';
import { PostPaymentParamsDto } from './types';

@Controller()
export class PaymentController {
  private readonly l = new Logger(PaymentController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly outboxService: OutboxService,
    private readonly kafkaConsumerService: KafkaConsumerService,
  ) {}

  @EventPattern('payments.requests')
  async handlePayment(
    @Payload() data: PostPaymentParamsDto,
    @Ctx() context: KafkaContext,
  ) {
    return await this.kafkaConsumerService.consume({
      spanName: 'PaymentConsumer.handlePayment',
      data,
      context,
      responseTopic: KafkaTopicGroup.PAYMENTS_RESPONSES,
      dlqTopic: KafkaTopicGroup.PAYMENTS_DLQ,
      handler: async ({ data, activeSpan, responseTopic }) => {
        return await this.paymentService.executePayment({
          params: data,
          topic: responseTopic,
          activeSpan,
        });
      },
    });
  }
}
```

- [ ] **Step 7: Delete `getPayment` and `listPayments` from `apps/worker/src/payment/payment.service.ts`** (keep `executePayment` and its private helpers as-is; also remove the now-unused `UserRawDto`, `ListPaymentsResponseDto`, `PaymentRawDto` imports from that file if nothing else in it references them).

- [ ] **Step 8: Verify both apps build**

Run: `nest build api` (or whatever Task 2 Step 5 determined) — expected: succeeds, includes the new `payment-query` routes.
Run: `yarn build:worker` — expected: succeeds.

- [ ] **Step 9: Verify api serves the read routes**

Run api's dev start command in one terminal. In another:

```bash
curl -s http://localhost:$PORT/api/payment -H "Authorization: Bearer $TEST_JWT"
```
(use whatever local auth mechanism the existing `apps/api/test/app.e2e-spec.ts` or seed data uses to get a valid token/user)

Expected: `200` with `{"payments": [...]}`, not a 404 — confirms the route moved successfully.

- [ ] **Step 10: Stage only this task's files and commit.** Move to Task 5.

---

## Task 5: `KafkaProducerService` in `apps/worker`

**Files:**
- Create: `backend/apps/worker/src/kafka/kafka-producer.service.ts`
- Create: `backend/apps/worker/src/kafka/kafka-producer.module.ts`
- Test: `backend/apps/worker/src/kafka/kafka-producer.service.spec.ts`

**Interfaces:**
- Produces: `KafkaProducerService.send({ topic: string, key: string, value: unknown }): Promise<void>` — connects lazily, reused by Task 6's mailman.

- [ ] **Step 1: Write the failing test**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { KafkaProducerService } from './kafka-producer.service';
import { ApiConfigService } from '@app/common/api-config/api-config.service';

describe('KafkaProducerService', () => {
  let service: KafkaProducerService;
  let mockProducer: { connect: jest.Mock; send: jest.Mock; disconnect: jest.Mock };

  beforeEach(async () => {
    mockProducer = {
      connect: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KafkaProducerService,
        {
          provide: ApiConfigService,
          useValue: {
            get: (key: string) =>
              ({ kafka_broker: 'localhost:9092', node_env: 'test' }[key]),
          },
        },
      ],
    }).compile();

    service = module.get(KafkaProducerService);
    (service as any).kafkaProducer = mockProducer;
  });

  it('sends the message with the given key, topic, and JSON-stringified value', async () => {
    await service.send({ topic: 'payments.responses', key: 'idem-1', value: { a: 1 } });

    expect(mockProducer.send).toHaveBeenCalledWith({
      topic: 'payments.responses',
      messages: [{ key: 'idem-1', value: JSON.stringify({ a: 1 }) }],
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test kafka-producer.service.spec.ts`
Expected: FAIL — `Cannot find module './kafka-producer.service'`.

- [ ] **Step 3: Implement `kafka-producer.service.ts`**

```typescript
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';
import { ApiConfigService } from '@app/common/api-config/api-config.service';
import { Environment } from '@app/common/types';

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private kafkaProducer: Producer;
  private connected = false;

  constructor(private readonly configService: ApiConfigService) {
    const isLocalKafka = [Environment.local, Environment.test].includes(
      this.configService.get('node_env'),
    );

    const kafka = new Kafka({
      brokers: [this.configService.get('kafka_broker')],
      ...(isLocalKafka
        ? {}
        : {
            ssl: true,
            sasl: {
              mechanism: 'plain',
              username: this.configService.get('kafka_api_key'),
              password: this.configService.get('kafka_api_secret'),
            },
          }),
    });

    this.kafkaProducer = kafka.producer();
  }

  async onModuleInit() {
    await this.kafkaProducer.connect();
    this.connected = true;
  }

  async onModuleDestroy() {
    if (this.connected) {
      await this.kafkaProducer.disconnect();
    }
  }

  public async send({
    topic,
    key,
    value,
  }: {
    topic: string;
    key: string;
    value: unknown;
  }): Promise<void> {
    await this.kafkaProducer.send({
      topic,
      messages: [{ key, value: JSON.stringify(value) }],
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test kafka-producer.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Create `kafka-producer.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/api-config/api-config.module';
import { KafkaProducerService } from './kafka-producer.service';

@Module({
  imports: [ApiConfigModule],
  providers: [KafkaProducerService],
  exports: [KafkaProducerService],
})
export class KafkaProducerModule {}
```

- [ ] **Step 6: Stage only this task's files and commit.** Move to Task 6.

---

## Task 6: `OutboxPublisherService` (the mailman)

**Files:**
- Create: `backend/apps/worker/src/outbox/outbox-publisher.service.ts`
- Modify: `backend/apps/worker/src/outbox/outbox.module.ts` (imports `CronModule` and `KafkaProducerModule` directly — no change to `app.module.ts` needed, both reach `WorkerAppModule` transitively via `PaymentModule → OutboxModule`)
- Test: `backend/apps/worker/src/outbox/outbox-publisher.service.spec.ts`

**Interfaces:**
- Consumes: `KafkaProducerService.send(...)` (Task 5), `CronService.add(...)` (`apps/worker/src/cron/cron.service.ts`, moved in Task 3, signature `add(time: {cronTime: string}, fun: () => any, key: string)`), `DbUtilsService.wrapInTransaction` (`@app/common/utils/db-utils`).
- Produces: every unpublished, due `Outbox` row eventually gets published to Kafka exactly-once-effectively (at-least-once on crash, per the spec's acknowledged duplicate-on-crash trade-off), topic-agnostically.

- [ ] **Step 1: Write the failing test**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { OutboxPublisherService } from './outbox-publisher.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { DbUtilsService } from '@app/common/utils/db-utils/db-utils.service';
import { getModelToken } from '@nestjs/sequelize';
import Outbox from '@app/common/models/outbox.model';

describe('OutboxPublisherService', () => {
  let service: OutboxPublisherService;
  let kafkaProducer: { send: jest.Mock };
  let sequelizeQuery: jest.Mock;

  beforeEach(async () => {
    kafkaProducer = { send: jest.fn().mockResolvedValue(undefined) };
    sequelizeQuery = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxPublisherService,
        { provide: KafkaProducerService, useValue: kafkaProducer },
        {
          provide: DbUtilsService,
          useValue: {
            wrapInTransaction: (fn: any) => fn({ sequelize: { query: sequelizeQuery } }),
          },
        },
        { provide: getModelToken(Outbox), useValue: { sequelize: { query: sequelizeQuery } } },
      ],
    }).compile();

    service = module.get(OutboxPublisherService);
  });

  it('publishes each due unpublished row and marks it published', async () => {
    sequelizeQuery
      .mockResolvedValueOnce([
        [{ id: 'row-1', topic: 'payments.responses', payload: { idempotency_key: 'idem-1' }, extra: null, error: null }],
      ])
      .mockResolvedValueOnce(undefined);

    await service.drain();

    expect(kafkaProducer.send).toHaveBeenCalledWith({
      topic: 'payments.responses',
      key: 'idem-1',
      value: { payload: { idempotency_key: 'idem-1' }, extra: null, error: null },
    });
    expect(sequelizeQuery).toHaveBeenLastCalledWith(
      expect.stringContaining('SET "publishedAt"'),
      expect.objectContaining({ replacements: { id: 'row-1' } }),
    );
  });

  it('bumps attempts and backs off on publish failure, without throwing', async () => {
    sequelizeQuery
      .mockResolvedValueOnce([
        [{ id: 'row-2', topic: 'payments.dlq', payload: {}, extra: null, error: null }],
      ])
      .mockResolvedValueOnce(undefined);
    kafkaProducer.send.mockRejectedValueOnce(new Error('broker unreachable'));

    await expect(service.drain()).resolves.not.toThrow();

    expect(sequelizeQuery).toHaveBeenLastCalledWith(
      expect.stringContaining('attempts = attempts + 1'),
      expect.objectContaining({ replacements: expect.objectContaining({ id: 'row-2' }) }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test outbox-publisher.service.spec.ts`
Expected: FAIL — `Cannot find module './outbox-publisher.service'`.

- [ ] **Step 3: Implement `outbox-publisher.service.ts`**

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import Outbox from '@app/common/models/outbox.model';
import { DbUtilsService } from '@app/common/utils/db-utils/db-utils.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { CronService } from '../cron/cron.service';

const BATCH_SIZE = 50;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

interface DueRow {
  id: string;
  topic: string;
  payload: any;
  extra: any;
  error: any;
}

@Injectable()
export class OutboxPublisherService implements OnModuleInit {
  private readonly l = new Logger(OutboxPublisherService.name);

  constructor(
    @InjectModel(Outbox) private readonly outboxModel: typeof Outbox,
    private readonly dbUtilsService: DbUtilsService,
    private readonly kafkaProducerService: KafkaProducerService,
    private readonly cronService: CronService,
  ) {}

  onModuleInit() {
    this.cronService.add(
      { cronTime: '*/2 * * * * *' },
      () => this.drain(),
      'outbox-publisher',
    );
  }

  public async drain(): Promise<void> {
    const dueRows = await this.dbUtilsService.wrapInTransaction<DueRow[]>(
      async (tx) => {
        const [rows] = await this.outboxModel.sequelize!.query(
          `SELECT id, topic, payload, extra, error
           FROM "Outbox"
           WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= NOW()
           ORDER BY "createdAt"
           LIMIT :limit
           FOR UPDATE SKIP LOCKED`,
          { replacements: { limit: BATCH_SIZE }, transaction: tx },
        );

        return rows as unknown as DueRow[];
      },
    );

    for (const row of dueRows) {
      await this.publishOne(row);
    }
  }

  private async publishOne(row: DueRow): Promise<void> {
    const key =
      row.payload?.idempotency_key ?? row.payload?.idempotencyKey ?? row.id;

    try {
      await this.kafkaProducerService.send({
        topic: row.topic,
        key,
        value: { payload: row.payload, extra: row.extra, error: row.error },
      });

      await this.outboxModel.sequelize!.query(
        `UPDATE "Outbox" SET "publishedAt" = NOW() WHERE id = :id`,
        { replacements: { id: row.id } },
      );
    } catch (err) {
      this.l.warn(
        `Failed to publish outbox row ${row.id} to topic ${row.topic}: ${(err as Error).message}`,
      );

      const backoffMs = Math.min(
        BASE_BACKOFF_MS * 2 ** 0,
        MAX_BACKOFF_MS,
      );
      const jitterMs = Math.floor(Math.random() * 500);

      await this.outboxModel.sequelize!.query(
        `UPDATE "Outbox"
         SET attempts = attempts + 1,
             "nextAttemptAt" = NOW() + (:delayMs || ' milliseconds')::interval
         WHERE id = :id`,
        { replacements: { id: row.id, delayMs: backoffMs + jitterMs } },
      );
    }
  }
}
```

Note: the backoff calculation above uses attempt `0`'s delay (`BASE_BACKOFF_MS`) for every failure, because the row's `attempts` value read at query time is from *before* this failure increments it. This is an intentional simplification for the first pass — the exponential term only starts compounding from the row's second failure onward once `attempts` in the `WHERE`-selected row reflects prior failures. If you want true from-row-one exponential backoff, thread the row's current `attempts` into `Math.min(BASE_BACKOFF_MS * 2 ** row.attempts, MAX_BACKOFF_MS)` — adjust the two test cases' assertions accordingly if you make this change, since the second test only exercises a first failure (`attempts` starts at 0).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test outbox-publisher.service.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it into `outbox.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/api-config/api-config.module';
import { DbUtilsModule } from '@app/common/utils/db-utils/db-utils.module';
import { OutboxDtoModule } from '../outbox-dto/outbox-dto.module';
import Outbox from '@app/common/models/outbox.model';
import { OutboxService } from './outbox.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import { KafkaProducerModule } from '../kafka/kafka-producer.module';
import { CronModule } from '../cron/cron.module';

@Module({
  imports: [
    SequelizeModule.forFeature([Outbox]),
    ApiConfigModule,
    DbUtilsModule,
    OutboxDtoModule,
    KafkaProducerModule,
    CronModule,
  ],
  providers: [OutboxService, OutboxPublisherService],
  exports: [OutboxService],
})
export class OutboxModule {}
```

- [ ] **Step 6: Verify worker still builds**

Run: `yarn build:worker`
Expected: succeeds.

- [ ] **Step 7: Live-drain smoke test**

With Docker infra up, `yarn start:dev:worker` running, and at least one `Outbox` row present (from Task 3 Step 10's test payment, or insert one manually):

```bash
docker exec -it payment_system_db psql -U "$DB_USERNAME" -d "$DB_NAME" -c 'SELECT id, topic, "publishedAt" FROM "Outbox" ORDER BY "createdAt" DESC LIMIT 5;'
```

Expected: within ~2 seconds of worker starting, previously-`NULL` `publishedAt` values become non-null. Confirm the message landed in Kafka too:

```bash
docker exec -it payment_system_kafka rpk topic consume payments.responses -n 1
```
Expected: prints the JSON `{payload, extra, error}` you just drained.

- [ ] **Step 8: Stage only this task's files and commit.** Move to Task 7.

---

## Task 7: Circuit breaker around Stripe

**Files:**
- Modify: `backend/apps/worker/src/stripe/stripe.service.ts`
- Modify: `backend/apps/worker/src/payment/types.ts` (add `Domain_CircuitBreakerOpenError`)
- Test: `backend/apps/worker/src/stripe/stripe.service.spec.ts`

**Interfaces:**
- Produces: `StripeService.createPaymentIntent(...)` throws `Domain_CircuitBreakerOpenError` (an `AppError`, `ErrorArea.DOMAIN`) instead of hanging/timing out when Stripe has been failing repeatedly — same call signature as before, so `payment.service.ts` needs no changes.

- [ ] **Step 1: Add the dependency**

Run: `yarn add opossum && yarn add -D @types/opossum`

- [ ] **Step 2: Add `Domain_CircuitBreakerOpenError` to `apps/worker/src/payment/types.ts`**, right after `Domain_StripePaymentFailed`:

```typescript
export class Domain_CircuitBreakerOpenError extends AppError {
  constructor(params?: ConfiguredErrorParams) {
    super({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      detail: 'Stripe circuit breaker is open',
      title: 'Payment provider unavailable',
      area: ErrorArea.DOMAIN,
      ...params,
    });
  }
}
```

(`HttpStatus.SERVICE_UNAVAILABLE` is already imported via the existing `HttpStatus` import in that file.)

- [ ] **Step 3: Write the failing test**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { StripeService } from './stripe.service';
import { ApiConfigService } from '@app/common/api-config/api-config.service';
import { ErrorUtilsService } from '@app/common/utils/error-utils/error-utils.service';
import { Domain_CircuitBreakerOpenError } from '../payment/types';

describe('StripeService circuit breaker', () => {
  let service: StripeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeService,
        {
          provide: ApiConfigService,
          useValue: {
            get: (key: string) =>
              ({ stripe_secret_key: 'sk_test_x', is_load_test: false }[key]),
          },
        },
        { provide: ErrorUtilsService, useValue: { captureSentryException: jest.fn() } },
      ],
    }).compile();

    service = module.get(StripeService);
    (service as any).stripe.paymentIntents.create = jest
      .fn()
      .mockRejectedValue(new Error('Stripe is down'));
  });

  it('opens the breaker after repeated failures and fails fast with a domain error', async () => {
    for (let i = 0; i < 10; i++) {
      await service
        .createPaymentIntent({ amount: 100, paymentMethodId: 'pm_1', idempotencyKey: `k${i}` })
        .catch(() => {});
    }

    await expect(
      service.createPaymentIntent({ amount: 100, paymentMethodId: 'pm_1', idempotencyKey: 'k-final' }),
    ).rejects.toBeInstanceOf(Domain_CircuitBreakerOpenError);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `yarn test stripe.service.spec.ts`
Expected: FAIL — the current implementation rejects with the raw Stripe error, not `Domain_CircuitBreakerOpenError` (opossum isn't wired in yet).

- [ ] **Step 5: Wrap `createPaymentIntent` with opossum**

In `stripe.service.ts`, add the import and a breaker field, and change the constructor and `createPaymentIntent` method:

```typescript
import CircuitBreaker from 'opossum';
import { Domain_CircuitBreakerOpenError } from '../payment/types';
```

```typescript
  private readonly createPaymentIntentBreaker: CircuitBreaker<
    [{ amount: number; paymentMethodId: string; idempotencyKey: string }],
    Response<PaymentIntent>
  >;

  constructor(
    private readonly configService: ApiConfigService,
    private readonly errorUtilsService: ErrorUtilsService,
  ) {
    this.stripe = new Stripe(this.configService.get('stripe_secret_key'), {
      apiVersion: '2026-03-25.dahlia',
    });

    this.createPaymentIntentBreaker = new CircuitBreaker(
      (params: { amount: number; paymentMethodId: string; idempotencyKey: string }) =>
        this.createPaymentIntentUnprotected(params),
      { errorThresholdPercentage: 50, resetTimeout: 10_000, timeout: 15_000 },
    );
  }
```

Rename the existing method body to a private `createPaymentIntentUnprotected`, and make the public `createPaymentIntent` delegate through the breaker:

```typescript
  public async createPaymentIntent(params: {
    amount: number;
    paymentMethodId: string;
    idempotencyKey: string;
  }): Promise<Response<PaymentIntent>> {
    try {
      return await this.createPaymentIntentBreaker.fire(params);
    } catch (error) {
      if (this.createPaymentIntentBreaker.opened) {
        throw new Domain_CircuitBreakerOpenError({ causes: [error] });
      }
      throw error;
    }
  }

  private async createPaymentIntentUnprotected({
    amount,
    paymentMethodId,
    idempotencyKey,
  }: {
    amount: number;
    paymentMethodId: string;
    idempotencyKey: string;
  }): Promise<Response<PaymentIntent>> {
    if (this.configService.get('is_load_test')) {
      return {
        status: 'succeeded',
        payment_method: paymentMethodId,
        amount,
        currency: 'usd',
        created: Date.now(),
      } as any;
    }

    return await this.stripe.paymentIntents.create(
      {
        amount,
        currency: 'usd',
        payment_method: paymentMethodId,
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      },
      { idempotencyKey },
    );
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `yarn test stripe.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Verify worker still builds**

Run: `yarn build:worker`
Expected: succeeds.

- [ ] **Step 8: Stage only this task's files and commit.** Move to Task 8.

---

## Task 8: Redis pub/sub + `realtime-notifier` consumer in `apps/realtime`

**Files:**
- Modify: `backend/libs/common/src/api-config/types.ts`, `backend/libs/common/src/api-config/api-config.service.ts` (add `redis_url`)
- Create: `backend/apps/realtime/src/redis-pubsub/redis-pubsub.service.ts`, `redis-pubsub.module.ts`
- Create: `backend/apps/realtime/src/realtime-notifier/realtime-notifier.controller.ts`, `realtime-notifier.module.ts`
- Modify: `backend/apps/realtime/src/app.module.ts`, `backend/apps/realtime/src/main.ts`
- Delete: `backend/apps/realtime/src/app.controller.ts`, `app.controller.spec.ts`, `app.service.ts` (Task 9 adds the real controller)
- Test: `backend/apps/realtime/src/redis-pubsub/redis-pubsub.service.spec.ts`

**Interfaces:**
- Produces: `RedisPubSubService.publish(channel: string, message: unknown): Promise<void>` and `RedisPubSubService.subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>>` (returns an unsubscribe function) — Task 9's SSE endpoint consumes `subscribe`.

- [ ] **Step 1: Add config**

In `backend/libs/common/src/api-config/types.ts`, add to `SecretsManagerConfig` (near `kafka_broker`):

```typescript
  redis_url: string;
```

In `backend/libs/common/src/api-config/api-config.service.ts`, find the `kafka_broker: { verify: joi.string().required(), name: 'KAFKA_BROKER' }` entry and add right after it:

```typescript
          redis_url: {
            verify: joi.string().required(),
            name: 'REDIS_URL',
          },
```

Add `REDIS_URL=redis://localhost:6300` to `backend/.env` (matches the `docker-compose.yaml` port mapping for the existing `redis` container).

- [ ] **Step 2: Add the dependency**

Run: `yarn add ioredis`

- [ ] **Step 3: Write the failing test for `RedisPubSubService`**

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { RedisPubSubService } from './redis-pubsub.service';
import { ApiConfigService } from '@app/common/api-config/api-config.service';

describe('RedisPubSubService', () => {
  let service: RedisPubSubService;
  let publisherClient: { publish: jest.Mock };
  let subscriberClient: { subscribe: jest.Mock; unsubscribe: jest.Mock; on: jest.Mock };

  beforeEach(async () => {
    publisherClient = { publish: jest.fn().mockResolvedValue(1) };
    subscriberClient = {
      subscribe: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisPubSubService,
        { provide: ApiConfigService, useValue: { get: () => 'redis://localhost:6300' } },
      ],
    }).compile();

    service = module.get(RedisPubSubService);
    (service as any).publisher = publisherClient;
    (service as any).subscriber = subscriberClient;
  });

  it('publishes a JSON-stringified message to the given channel', async () => {
    await service.publish('payments:sse:idem-1', { status: 'COMPLETED' });

    expect(publisherClient.publish).toHaveBeenCalledWith(
      'payments:sse:idem-1',
      JSON.stringify({ status: 'COMPLETED' }),
    );
  });

  it('subscribes to a channel and routes matching messages to the callback', async () => {
    const onMessage = jest.fn();
    let registeredHandler: (channel: string, message: string) => void = () => {};
    subscriberClient.on.mockImplementation((event: string, handler: any) => {
      if (event === 'message') registeredHandler = handler;
    });

    await service.subscribe('payments:sse:idem-1', onMessage);
    registeredHandler('payments:sse:idem-1', '{"status":"COMPLETED"}');
    registeredHandler('payments:sse:some-other-key', '{"status":"FAILED"}');

    expect(subscriberClient.subscribe).toHaveBeenCalledWith('payments:sse:idem-1');
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('{"status":"COMPLETED"}');
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `yarn test redis-pubsub.service.spec.ts`
Expected: FAIL — `Cannot find module './redis-pubsub.service'`.

- [ ] **Step 5: Implement `redis-pubsub.service.ts`**

```typescript
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { ApiConfigService } from '@app/common/api-config/api-config.service';

@Injectable()
export class RedisPubSubService implements OnModuleDestroy {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

  constructor(private readonly configService: ApiConfigService) {
    const url = this.configService.get('redis_url');
    this.publisher = new Redis(url);
    this.subscriber = new Redis(url);
  }

  public async publish(channel: string, message: unknown): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(message));
  }

  public async subscribe(
    channel: string,
    onMessage: (message: string) => void,
  ): Promise<() => Promise<void>> {
    const handler = (receivedChannel: string, message: string) => {
      if (receivedChannel === channel) {
        onMessage(message);
      }
    };

    this.subscriber.on('message', handler);
    await this.subscriber.subscribe(channel);

    return async () => {
      this.subscriber.off('message', handler);
      await this.subscriber.unsubscribe(channel);
    };
  }

  async onModuleDestroy() {
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `yarn test redis-pubsub.service.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Create `redis-pubsub.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/api-config/api-config.module';
import { RedisPubSubService } from './redis-pubsub.service';

@Module({
  imports: [ApiConfigModule],
  providers: [RedisPubSubService],
  exports: [RedisPubSubService],
})
export class RedisPubSubModule {}
```

- [ ] **Step 8: Create the `realtime-notifier` consumer controller**

```typescript
// apps/realtime/src/realtime-notifier/realtime-notifier.controller.ts
import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { RedisPubSubService } from '../redis-pubsub/redis-pubsub.service';

interface OutboxEventEnvelope {
  payload: { idempotency_key?: string; idempotencyKey?: string };
  extra?: { payment?: { id: string; status: string } };
  error?: unknown;
}

@Controller()
export class RealtimeNotifierController {
  private readonly l = new Logger(RealtimeNotifierController.name);

  constructor(private readonly redisPubSubService: RedisPubSubService) {}

  @EventPattern('payments.responses')
  async handleResponse(@Payload() data: OutboxEventEnvelope) {
    await this.relay(data);
  }

  @EventPattern('payments.dlq')
  async handleDlq(@Payload() data: OutboxEventEnvelope) {
    await this.relay(data);
  }

  private async relay(data: OutboxEventEnvelope): Promise<void> {
    const idempotencyKey =
      data.payload?.idempotency_key ?? data.payload?.idempotencyKey;

    if (!idempotencyKey) {
      this.l.warn('Outbox event missing idempotency key, dropping', { data });
      return;
    }

    await this.redisPubSubService.publish(`payments:sse:${idempotencyKey}`, {
      idempotencyKey,
      status: data.extra?.payment?.status,
      paymentId: data.extra?.payment?.id,
      error: data.error,
    });
  }
}
```

```typescript
// apps/realtime/src/realtime-notifier/realtime-notifier.module.ts
import { Module } from '@nestjs/common';
import { RedisPubSubModule } from '../redis-pubsub/redis-pubsub.module';
import { RealtimeNotifierController } from './realtime-notifier.controller';

@Module({
  imports: [RedisPubSubModule],
  controllers: [RealtimeNotifierController],
})
export class RealtimeNotifierModule {}
```

- [ ] **Step 9: Delete the placeholder scaffolding and rewrite `apps/realtime/src/app.module.ts`**

```bash
rm apps/realtime/src/app.controller.ts apps/realtime/src/app.controller.spec.ts apps/realtime/src/app.service.ts
```

```typescript
import { Module } from '@nestjs/common';
import { RealtimeNotifierModule } from './realtime-notifier/realtime-notifier.module';

@Module({
  imports: [RealtimeNotifierModule],
})
export class RealtimeAppModule {}
```

(Task 9 adds the SSE module to this same `imports` array.)

- [ ] **Step 10: Rewrite `apps/realtime/src/main.ts`** to run both HTTP (for Task 9's SSE) and the Kafka microservice under group `realtime-notifier`:

```typescript
import { NestFactory } from '@nestjs/core';
import { RealtimeAppModule } from './app.module';
import { ApiConfigService } from '@app/common/api-config/api-config.service';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Environment } from '@app/common/types';

async function bootstrap() {
  const app = await NestFactory.create(RealtimeAppModule, { bufferLogs: true });
  const configService = app.get(ApiConfigService);

  app.enableCors({ origin: true, methods: 'GET,HEAD,OPTIONS', credentials: true });
  app.setGlobalPrefix('api');

  const isLocalKafka = [Environment.local, Environment.test].includes(
    configService.get('node_env'),
  );

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: [configService.get('kafka_broker')],
        ...(isLocalKafka
          ? { retry: { retries: 0 } }
          : {
              ssl: true,
              sasl: {
                mechanism: 'plain',
                username: configService.get('kafka_api_key'),
                password: configService.get('kafka_api_secret'),
              },
            }),
      },
      consumer: { groupId: 'realtime-notifier' },
    },
  });

  app.enableShutdownHooks();
  await app.startAllMicroservices();
  await app.listen(configService.get('port'));
}

bootstrap();
```

Note this reuses `configService.get('port')` — the same port variable api uses. Since api and realtime run as separate processes, give realtime its own port at runtime via a `PORT` env override when starting it (e.g. `PORT=3001 yarn start:dev:realtime`) so it doesn't collide with api on the same machine during local dev.

- [ ] **Step 11: Verify realtime builds and boots**

Run: `yarn build:realtime`
Expected: succeeds.

Run: `PORT=3001 yarn start:dev:realtime`
Expected: logs show both the HTTP listener and the Kafka microservice (`realtime-notifier` group) starting, no crash.

- [ ] **Step 12: Live smoke test**

With worker (Task 6) and realtime both running, produce another test payment (same method as Task 3 Step 10). Watch realtime's logs for `RealtimeNotifierController` processing the `payments.responses` message, then confirm the Redis publish happened:

```bash
docker exec -it payment_system_redis redis-cli SUBSCRIBE "payments:sse:test-idem-key-1"
```
(run this *before* producing the test payment) — expected: the subscriber prints the JSON `{idempotencyKey, status, paymentId, error}` message.

- [ ] **Step 13: Stage only this task's files and commit.** Move to Task 9.

---

## Task 9: SSE endpoint in `apps/realtime`

**Files:**
- Create: `backend/apps/realtime/src/payment-stream/payment-stream.controller.ts`, `payment-stream.module.ts`
- Modify: `backend/apps/realtime/src/app.module.ts`

**Interfaces:**
- Consumes: `RedisPubSubService.subscribe` (Task 8), `PaymentDtoService.requestPaymentOptional` (`@app/common/payment-dto`), `@Firewall()` + `UserUtilsService.getUser` (`@app/common/auth`, `@app/common/utils/user-utils`).
- Produces: `GET /payment/stream?idempotencyKey=...` — an SSE stream terminating the connection once a terminal status (anything other than `PENDING`) is relayed.

- [ ] **Step 1: Create `payment-stream.controller.ts`**

```typescript
import { Controller, Query, Request, Sse } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Firewall } from '@app/common/auth/decorators/firewall.decorator';
import type { RequestWithUser } from '@app/common/types';
import { UserUtilsService } from '@app/common/utils/user-utils/user-utils.service';
import { PaymentDtoService } from '@app/common/payment-dto/payment-dto.service';
import { DbUtilsService } from '@app/common/utils/db-utils/db-utils.service';
import { RedisPubSubService } from '../redis-pubsub/redis-pubsub.service';

interface PaymentStreamEvent {
  idempotencyKey: string;
  status?: string;
  paymentId?: string;
  error?: unknown;
}

@Controller('payment')
export class PaymentStreamController {
  constructor(
    private readonly redisPubSubService: RedisPubSubService,
    private readonly paymentDtoService: PaymentDtoService,
    private readonly dbUtilsService: DbUtilsService,
    private readonly userUtilsService: UserUtilsService,
  ) {}

  @Firewall()
  @Sse('stream')
  stream(
    @Query('idempotencyKey') idempotencyKey: string,
    @Request() request: RequestWithUser,
  ): Observable<{ data: PaymentStreamEvent }> {
    const viewerUser = this.userUtilsService.getUser(request);

    return new Observable((subscriber) => {
      let unsubscribeFn: (() => Promise<void>) | undefined;
      let closed = false;

      const validateOwnershipThenListen = async () => {
        const existingPayment = await this.dbUtilsService.wrapInTransaction((tx) =>
          this.paymentDtoService.requestPaymentOptional({
            params: { idempotencyKey },
            tx,
          }),
        );

        if (existingPayment && existingPayment.bisOrder?.userId !== viewerUser.id) {
          subscriber.error(new Error('Forbidden'));
          return;
        }

        unsubscribeFn = await this.redisPubSubService.subscribe(
          `payments:sse:${idempotencyKey}`,
          (message) => {
            if (closed) return;

            const event = JSON.parse(message) as PaymentStreamEvent;
            subscriber.next({ data: event });

            if (event.status && event.status !== 'PENDING') {
              subscriber.complete();
            }
          },
        );
      };

      validateOwnershipThenListen().catch((err) => subscriber.error(err));

      return () => {
        closed = true;
        void unsubscribeFn?.();
      };
    });
  }
}
```

- [ ] **Step 2: Create `payment-stream.module.ts`**

```typescript
import { Module } from '@nestjs/common';
import { AuthModule } from '@app/common/auth/auth.module';
import { DbUtilsModule } from '@app/common/utils/db-utils/db-utils.module';
import { UserUtilsModule } from '@app/common/utils/user-utils/user-utils.module';
import { PaymentDtoModule } from '@app/common/payment-dto/payment-dto.module';
import { RedisPubSubModule } from '../redis-pubsub/redis-pubsub.module';
import { PaymentStreamController } from './payment-stream.controller';

@Module({
  imports: [AuthModule, DbUtilsModule, UserUtilsModule, PaymentDtoModule, RedisPubSubModule],
  controllers: [PaymentStreamController],
})
export class PaymentStreamModule {}
```

- [ ] **Step 3: Register it in `apps/realtime/src/app.module.ts`**

Add `import { PaymentStreamModule } from './payment-stream/payment-stream.module';` and `PaymentStreamModule,` to the `imports` array alongside `RealtimeNotifierModule`.

- [ ] **Step 4: Verify realtime builds**

Run: `yarn build:realtime`
Expected: succeeds.

- [ ] **Step 5: End-to-end SSE smoke test**

With Docker infra, worker, and realtime all running (`PORT=3001 yarn start:dev:realtime`):

```bash
curl -N "http://localhost:3001/api/payment/stream?idempotencyKey=test-idem-key-2" \
  -H "Authorization: Bearer $TEST_JWT"
```

In another terminal, produce a test payment with `idempotency_key: "test-idem-key-2"` (same method as Task 3 Step 10).

Expected: the `curl -N` terminal prints an SSE `data: {...}` line containing `"status":"COMPLETED"` (or `"FAILED"`) within a few seconds, then the connection closes (since the controller calls `subscriber.complete()` on a terminal status).

- [ ] **Step 6: Stage only this task's files and commit.** Move to Task 10.

---

## Task 10: End-to-end reliability verification

No new files — this task only runs the roadmap's stated done-when scenarios against everything built in Tasks 1–9, to confirm the whole loop actually works together, not just each piece in isolation.

- [ ] **Step 1: Outbox survives a Kafka outage**

With worker, realtime, and Docker infra running, and a `curl -N .../payment/stream?idempotencyKey=...` open and waiting:

```bash
docker stop payment_system_kafka
```

Produce a payment is not possible with Kafka down (the edge itself would fail to publish) — instead, verify the *drain* side of the story: insert an `Outbox` row directly to simulate a payment that already completed processing before Kafka died:

```bash
docker exec -it payment_system_db psql -U "$DB_USERNAME" -d "$DB_NAME" -c "
INSERT INTO \"Outbox\" (id, topic, payload, \"nextAttemptAt\", \"createdAt\")
VALUES (gen_random_uuid(), 'payments.responses', '{\"idempotency_key\":\"chaos-test-1\"}', NOW(), NOW());
"
```

Expected: worker's `OutboxPublisherService` logs repeated failed-publish warnings every ~2s (Kafka unreachable), and the row's `attempts` climbs / `nextAttemptAt` keeps moving forward — confirm with the same `SELECT` from Task 6 Step 7.

- [ ] **Step 2: Restart Kafka and confirm the backlog drains**

```bash
docker start payment_system_kafka
```

Expected: within a few polling cycles, the `chaos-test-1` row's `publishedAt` becomes non-null, and (if you kept an SSE stream open for `idempotencyKey=chaos-test-1`, opened via `curl -N` per Task 9 Step 5 before stopping Kafka) it receives the relayed status and closes.

- [ ] **Step 3: Circuit breaker opens under repeated Stripe failures**

This is already covered by Task 7's unit test in isolation. For a live check: temporarily set an invalid `STRIPE_SECRET_KEY` in `.env`, restart worker, and produce ~10 test payments in a row (Task 3 Step 10's method, varying `idempotency_key` each time). Expected: worker's logs show Stripe calls failing normally at first, then — once opossum's error threshold trips — subsequent calls fail immediately with `Domain_CircuitBreakerOpenError` rather than waiting out Stripe's own timeout. Restore the valid key afterward.

- [ ] **Step 4: Stop.** All of Plan 1's done-when criteria (#1, #5, #9, #24 from the spec) are verified. Report back before starting the next plan (OCC/refund — Plan 2).

---

## Self-Review Notes

**Spec coverage:** §1 (workspace split) → Task 2 (now via Nest's own `generate app`/`generate library` schematics, not a hand-rolled tsconfig widening) + Task 3/4 (module relocation). §4 (outbox mailman) → Tasks 1 (done), 5, 6. §5b (circuit breaker only — OCC/refund is Plan 2, not this plan) → Task 7. §7 realtime-notifier half (search-indexer is Plan 3) → Task 8. §8 (SSE) → Task 9. Done-when table rows #1, #5, #9, #24 → Task 10. Rows #6, #13–16, #20 are explicitly out of scope for this plan per the four-plan split agreed with the user.

**Revision history:** Task 2 was rewritten after the first execution attempt revealed the original design's core assumption was wrong — `nest generate app` relocates the existing project into `apps/<package-name>`, it does not leave it at root, and the plan's original "widen tsconfig `rootDir`/`include` to reach across from a new app into an unmoved root `src/`" approach was fighting that behavior rather than working with it (surfaced as duplicated compiled output, `deleteOutDir` conflicts, and a near-miss where an early `nest generate app` run deleted `src/`/`test/` before `monorepo: true` was set). This version uses Nest's own `nest generate library common` mechanism instead, confirmed with the user as the preferred, more idiomatic approach, with a wildcard path alias (`@app/common/*`) added on top of the schematic's default barrel mapping so deep imports keep working. Every downstream task's shared-code import paths were updated from `src/...` to `@app/common/...` accordingly, and worker-exclusive move-source paths were updated from `src/...` to `apps/api/src/...` to match where Nest's relocation actually puts things.
