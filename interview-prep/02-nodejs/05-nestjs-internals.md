# NestJS Internals and Architecture

Nest is your primary framework, so expect to be questioned on it hard. Know the **request lifecycle**, the **DI container**, **scopes**, and how to structure a large app.

---

## 1. Request lifecycle: exact order

```
Incoming request
  → Middleware            (global → module-bound)            Express/Fastify level; no ExecutionContext
  → Guards                (global → controller → route)      authN/authZ; return boolean / throw
  → Interceptors (before) (global → controller → route)      logging, caching, timing, transform request
  → Pipes                 (global → controller → route → param)  validation & transformation
  → Route handler
  → Interceptors (after)  (route → controller → global)      reverse order; map/transform response (RxJS)
  → Exception filters     (route → controller → global)      first matching filter wins
  → Response
```

What goes where (a common interview question):
- **Middleware**: things that don't need to know the handler: request ID, raw body for webhook signatures, helmet, CORS, cookie parsing.
- **Guards**: *"should this request proceed?"* They see the `ExecutionContext` (which handler and class), so they can read metadata (`@Roles('admin')`) through `Reflector`. Authentication (JWT validation) and authorization (RBAC) both live here.
- **Interceptors**: AOP around the handler: timing, response mapping, caching, timeouts (`timeout()` RxJS operator), transaction wrapping, idempotency.
- **Pipes**: transform and validate *arguments* (`ValidationPipe`, `ParseUUIDPipe`).
- **Filters**: map exceptions to responses.

```ts
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required) return true;
    const { user } = ctx.switchToHttp().getRequest();
    return required.some((r) => user?.roles.includes(r));
  }
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`RolesGuard`](../../packages/backend/libs/domains/identity/api/guards/roles.guard.ts#L16): RolesGuard is a CanActivate guard that reads role metadata to decide whether a request proceeds. _(roles.guard.ts)_
> - [`ApiKeyGuard`](../../packages/backend/libs/domains/developer-platform/api/api-key.guard.ts#L17): ApiKeyGuard validates the Bearer token and scopes and sets tenant context before the handler runs. _(api-key.guard.ts)_
> - [`PublicApiInterceptor`](../../packages/backend/libs/domains/developer-platform/api/public-api.interceptor.ts#L26): PublicApiInterceptor handles versioning, deprecation headers, request IDs and logging around the handler. _(public-api.interceptor.ts)_
<!-- theory-links:end -->

---

## 2. Dependency injection container

- **Modules** define encapsulation boundaries. A provider is visible only inside its module unless the module **exports** it and the consumer **imports** that module.
- **Providers** are registered by token (a class, string, or symbol):
  ```ts
  { provide: PAYMENT_GATEWAY, useClass: env === 'test' ? FakeGateway : BankGateway }
  { provide: 'CONFIG', useValue: config }
  { provide: DataSource, useFactory: async (cfg: ConfigService) => createDs(cfg), inject: [ConfigService] }
  { provide: 'AliasedLogger', useExisting: Logger }
  ```
- Resolution uses TypeScript's `emitDecoratorMetadata` (`design:paramtypes`). Interfaces have no runtime existence, so injecting by interface needs a token plus `@Inject(TOKEN)`.
- **Circular dependencies**: `forwardRef(() => OtherModule)`. Treat them as a design smell; extract a third module or use events.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TransactionModule`](../../packages/backend/libs/infrastructure/context/transaction.module.ts#L10): TransactionModule is a global module that exports TransactionRunner, which shows module encapsulation with exports. _(transaction.module.ts)_
> - [`FirebaseModule`](../../packages/backend/libs/infrastructure/firebase/firebase.module.ts#L11): FirebaseModule provides and exports FirebaseService so that importing modules can inject it. _(firebase.module.ts)_ · [firebase](../../docs/humans/concepts/platform-firebase/firebase.md)
<!-- theory-links:end -->

### Injection scopes
| Scope | Instance per | Cost |
|---|---|---|
| `DEFAULT` (singleton) | app | none |
| `REQUEST` | each request | **bubbles up**: every provider that depends on a request-scoped provider becomes request-scoped too, and the whole chain is re-instantiated per request, which hurts performance |
| `TRANSIENT` | each injection | new instance per consumer |

**Senior answer:** avoid `REQUEST` scope for request context. Use `AsyncLocalStorage` (`nestjs-cls`) so services stay singletons and still read the current user, tenant, or transaction.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`createLoaders`](../../packages/backend/libs/composition/bff/graphql/loaders.ts#L16): createLoaders builds the per-request DataLoaders explicitly in the BFF, so the code needs no REQUEST-scoped providers. _(loaders.ts)_
> - [`AppClsStore`](../../packages/backend/libs/common/request-context/types.ts#L8): AppClsStore keeps request context in CLS instead of in request-scoped providers. _(types.ts)_ · [request-context](../../docs/humans/concepts/common-request-context/request-context.md)
<!-- theory-links:end -->

### Dynamic modules
```ts
@Module({})
export class BankModule {
  static forRootAsync(opts: { useFactory: (...a: any[]) => BankOptions; inject: any[] }): DynamicModule {
    return {
      module: BankModule,
      providers: [{ provide: BANK_OPTIONS, ...opts }, BankClient],
      exports: [BankClient],
      global: false,
    };
  }
}
```
`ConfigurableModuleBuilder` generates the boilerplate for `forRoot`/`forRootAsync`.

---

## 3. Lifecycle hooks

Order on startup: `onModuleInit` (per module, after its dependencies), then `onApplicationBootstrap`.
On shutdown (only with `app.enableShutdownHooks()`): `onModuleDestroy`, then `beforeApplicationShutdown(signal)`, then `onApplicationShutdown(signal)`.

Use them to: start and stop queue consumers, warm caches, and close connections.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`installGracefulShutdown`](../../packages/backend/libs/infrastructure/lifecycle/graceful-shutdown.ts#L28): installGracefulShutdown handles SIGTERM and SIGINT by setting readiness to false, draining, closing the server and running the shutdown hooks. _(graceful-shutdown.ts)_ · [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md)
> - [`ShutdownRegistry`](../../packages/backend/libs/infrastructure/lifecycle/shutdown-registry.service.ts#L17): ShutdownRegistry runs registered shutdown tasks in ascending order. _(shutdown-registry.service.ts)_ · [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md)
> - [`JobsWorkerModule`](../../packages/backend/libs/infrastructure/jobs/jobs-worker.module.ts#L19): JobsWorkerModule starts job workers and scheduling when the application bootstraps. _(jobs-worker.module.ts)_
<!-- theory-links:end -->

---

## 4. Transactions across services

Problem: `InvoiceService.create()` calls `LedgerService.post()`, and both writes must share one DB transaction without passing `tx` everywhere.

Options:
1. Pass `tx`/`EntityManager` explicitly. Simple and explicit, but noisy.
2. **CLS-based transactions**: `@nestjs-cls/transactional` with a Prisma, TypeORM, Knex, or Drizzle adapter. A `@Transactional()` decorator stores the transaction in AsyncLocalStorage, and repositories pick it up automatically.
3. Sequelize: `Sequelize.useCLS(namespace)` makes queries inside `sequelize.transaction(async () => ...)` join the transaction automatically.

Pitfalls: making an **external HTTP call inside a DB transaction** holds locks and a connection for the whole call. Also, firing events/messages before commit (use the outbox pattern).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TransactionRunner`](../../packages/backend/libs/infrastructure/context/transaction-runner.service.ts#L23): TransactionRunner runs work atomically with SERIALIZABLE retry, so services can share a transaction without passing tx around. _(transaction-runner.service.ts)_
> - [`enableSequelizeCls`](../../packages/backend/libs/infrastructure/context/sequelize-cls.ts#L36): enableSequelizeCls turns on CLS so Sequelize propagates the transaction automatically. _(sequelize-cls.ts)_
> - [`sequelizeClsNamespace`](../../packages/backend/libs/infrastructure/context/sequelize-cls.ts#L16): sequelizeClsNamespace is the CLS namespace implementation that carries the transaction. _(sequelize-cls.ts)_
<!-- theory-links:end -->

---

## 5. Project structure for a large Nest app

```
src/
  modules/
    invoicing/
      api/           controllers, DTOs (transport layer)
      application/   use-cases / services (orchestration, transactions)
      domain/        entities, value objects, domain services (pure, no Nest imports ideally)
      infra/         repositories, external clients, ORM models
      invoicing.module.ts
  shared/            config, logging, auth guards, filters, interceptors
```
- Keep the domain logic (for example a pricing or commission engine) **framework-free and pure**, so it's easy to unit test with table-driven tests.
- Communication between modules goes through exported services or domain events (`@nestjs/event-emitter` in-process, or a broker), never by importing another module's repository.
- **Modular monolith first**, and split into microservices only when there's a clear reason (independent scaling, team ownership, different release cadence).

---

## 6. Other Nest features to be ready on

- **Fastify adapter**: higher throughput, schema-based serialization. Some Express middleware won't work with it.
- **Microservices** (`@nestjs/microservices`): transports for TCP, Redis, NATS, Kafka, RabbitMQ, gRPC. `@MessagePattern` (request-response) vs `@EventPattern` (fire-and-forget). Hybrid apps (HTTP + microservice).
- **CQRS module**: CommandBus, QueryBus, EventBus, Sagas (RxJS).
- **Scheduling** (`@nestjs/schedule`): with N replicas, every pod runs the cron. Use a distributed lock (Redis or `pg_advisory_lock`), a K8s CronJob, or a single-replica worker deployment.
- **Queues**: `@nestjs/bullmq`.
- **Testing**:
  ```ts
  const moduleRef = await Test.createTestingModule({ imports: [InvoicingModule] })
    .overrideProvider(BankClient).useValue(fakeBank)
    .compile();
  const app = moduleRef.createNestApplication(); await app.init();
  await request(app.getHttpServer()).post('/invoices').send(dto).expect(201);
  ```
- **Health checks**: `@nestjs/terminus` (see the K8s probes doc for what to check).
- **Config**: `@nestjs/config` with a validation schema (zod/joi), so startup fails when config is missing.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`JobMaintenance`](../../packages/backend/libs/infrastructure/jobs/job-maintenance.service.ts#L25): JobMaintenance materializes job schedules and reaps leases, which lets cron jobs run safely with several replicas. _(job-maintenance.service.ts)_
> - [`src/main.ts`](../../packages/backend/apps/payment-processor/src/main.ts): The payment-processor main.ts bootstraps a NestJS Kafka microservice. · [payment-processor](../../docs/humans/concepts/app-payment-processor/payment-processor.md)
<!-- theory-links:end -->

---

## Interview Q&A

**Q: Where do you put authorization logic in Nest?**
Coarse RBAC goes in guards using metadata from custom decorators read through `Reflector`. Record-level access (whether this user can see invoice X) belongs in the service or repository layer, by scoping the query (`WHERE org_id = :orgId AND ...`) or with Postgres RLS, because a guard runs before the record is loaded. A central policy module that generates ORM query scopes (e.g. Sequelize scopes) per user keeps this consistent.

**Q: Why are request-scoped providers dangerous?**
Scope bubbles up the dependency chain, so a whole graph of providers gets instantiated per request, which costs CPU and GC pressure. Use AsyncLocalStorage (nestjs-cls) for per-request context instead.

**Q: Interceptor vs middleware for logging?**
Middleware can't see which handler will run and can't easily see the handler's return value. An interceptor has the ExecutionContext and can time the handler with RxJS `tap`. For raw access logs, middleware or pino-http is fine. For per-handler metrics, use an interceptor.

**Q: How do you run a cron job in Nest with 5 replicas?**
Don't run it in every replica. Use a K8s CronJob, a dedicated worker deployment with one replica, or a distributed lock (`pg_try_advisory_lock` / Redis lock with TTL). The job itself must be idempotent anyway.
