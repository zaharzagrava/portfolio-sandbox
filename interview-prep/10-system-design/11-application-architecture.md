# Application Architecture Patterns

When designing large-scale codebases, structural patterns help manage complexity, decouple logic from infrastructure, and enable independent scaling.

---

## 1. Modular Monolith

A **Modular Monolith** is a single deployable application where the codebase is strictly divided into independent, business-aligned modules (or domains).

**How it works:**
- All modules run in the same OS process and usually share the same database instance.
- Modules **cannot** directly import internal classes or directly read each other's database tables.
- Modules communicate through well-defined public interfaces (e.g., calling a public `OrderModuleService`) or by publishing in-memory domain events.

**Why use it over Microservices?**
Microservices solve **organizational** problems (enabling independent deployments for hundreds of engineers across many teams) but introduce massive **technical** complexity (network latency, distributed transactions, complex CI/CD, and tricky debugging). A modular monolith gives you the clean boundaries of microservices without the network tax. 

- ✅ **Refactoring:** Moving code between modules is just a Git commit, not a multi-week cross-repo API migration.
- ✅ **Simplicity:** No network boundaries, no distributed tracing required, simple local transactions.
- ✅ **Migration path:** Because boundaries are strict and imports are clean, if one module eventually experiences extreme load or requires an independent lifecycle, it can be easily extracted into a true microservice later.
- ❌ **Deployment coupling:** A bug in one module can crash the entire application process, and all modules share the same release cadence.

---

## 2. Hexagonal Architecture (Ports and Adapters)

**Hexagonal Architecture** strictly separates the core business logic from outside concerns (databases, UI, external APIs) by using interfaces (**Ports**).

**The Layers:**
1. **Core Domain (Center):** Contains the pure business logic, rules, and entities. It has **zero dependencies** on external frameworks, databases, or HTTP libraries.
2. **Ports:** 
   - *Primary (Driving) Ports:* Interfaces defining how the outside world can interact with the core (e.g., `CreateOrderUseCase`).
   - *Secondary (Driven) Ports:* Interfaces defining what the core needs from the outside world (e.g., `OrderRepository`).
3. **Adapters (Outer Edge):**
   - *Primary Adapters:* Controllers, CLI commands, or GraphQL resolvers that receive external signals and translate them into Core method calls via Primary Ports.
   - *Secondary Adapters:* Database implementations (e.g., `PostgresOrderRepository`), external API clients, or Email senders that implement the Secondary Ports.

**Why use it?**
- ✅ **Testability:** The core domain can be unit-tested instantly using in-memory mock adapters without spinning up a real database or HTTP server.
- ✅ **Technology Independence:** You can swap an Express HTTP adapter for a CLI adapter, or migrate from MongoDB to Postgres, entirely by swapping adapters without touching the core business logic.
- ❌ **Boilerplate:** Requires creating extensive interfaces and mapping domain objects to DTOs/Entities constantly. It is usually overkill for simple CRUD applications, but invaluable for domains with highly complex business rules.

---

## 3. Integrating many external systems: canonical model + anti-corruption layer

The integration-heavy application of hexagonal architecture (e.g. many PMS / payment / banking partners):
- **Canonical model**: our own, partner-independent version of the domain concepts (`Lease`, `Charge`, `Tenant`, events like `ChargePosted`), the only shape the core understands. It never sees a partner's payload.
- **Anti-corruption layer (ACL)** (Domain-Driven Design): the translation layer at the border that turns *their* model into *ours*, so their naming, quirks and bugs don't "corrupt" our domain. In code: each adapter's parser + mapper.
- **One secondary port** (`PmsConnector`: verify, parse, map to canonical, fetch, write back) + **one adapter per partner** + a registry `partner → adapter`. Adapters declare **capabilities** (has sequence numbers? event API? write-back?) and the core picks the matching mode.
- Mappers are **pure functions** → golden-file tests on recorded real payloads; a **shared test suite** every adapter must pass.
- Adapters **return** canonical events; only the core writes to the DB after validating business invariants. A mapper bug yields rejected events, not corrupted data.
- N partners × M consumers: without a canonical model every consumer learns every format (N×M); with it, N mappers + M consumers of one model.
- Worked example: [practice/01](../practice/01-pms-webhook-ingestion.md#6-code-structure-ports--adapters--canonical-model-step-2).
