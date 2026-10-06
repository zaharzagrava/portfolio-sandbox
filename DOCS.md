# Artifacts

Live Load Test Under Stress: \* Left Side: A terminal running k6 or Locust blasting 10,000+ RPS at your API.

- Right Side: A Grafana dashboard showing incoming requests vs. database connection pool, Kafka consumer lag, and Upstash Redis rate-limit rejections.

Chaos Testing / Fault Tolerance (The Killer Feature):

- Show the load test running, then kill the Kafka container or Postgres connection mid-flight.
- Show your system catching the errors, holding events safely in the Outbox table, and resuming processing with zero dropped payments once the container restarts.
- Nothing earns a Tech Lead's respect faster than demonstrating fault recovery under load.

# Backlog

Change Data Capture (CDC): Instead of writing a custom application-level worker to poll your Outbox table, integrate Debezium. Debezium reads the PostgreSQL Write-Ahead Log (WAL) directly and streams the changes to Kafka. This is the enterprise standard for event-driven architectures.

Read-Optimized Views: For the user balance page, aggregating millions of LedgerEntry rows on the fly will eventually bottleneck. Use Kafka to consume ledger events and project a "Current Balance" read-model into Redis or Cassandra. Your Next.js frontend queries this lightning-fast cache, while Postgres remains the source of truth.

Database Sharding Strategy: Document or implement a sharding key for your Postgres database (e.g., sharding the ledger by accountId) to show you understand how to scale relational databases horizontally.

## Edge & API Layer

API Gateway / BFF (Backend for Frontend): Implement an API Gateway pattern. You can use GraphQL (Apollo Federation) to aggregate data from your Payment service, Search service (Elasticsearch), and User service into a single graph for the frontend.

Distributed Rate Limiting: Implement a sliding window or token bucket rate limiter using Redis. Protect your payment creation endpoints from DDoS or retry-storms.

Idempotency Handling: You have an idempotencyKey in your model (ensure it has a UNIQUE constraint). Build a middleware interceptor that checks Redis for the idempotency key before it even hits the Postgres database, serving the cached response if the request was already processed.

## Real-time interactions

Server-Sent Events (SSE) or WebSockets: When a user initiates a payment, the status might go from PENDING -> PROCESSING -> SUCCESS via asynchronous Kafka workers. Push these status changes from Kafka back to the Next.js frontend in real-time using WebSockets or SSE, creating a reactive user experience.

## Infrastructure and DevEx

Chaos Engineering: Write a script (using a tool like Toxiproxy) that randomly drops network connections to Kafka or Redis while a load test is running. Use your Grafana/OTEL dashboards to prove that your Outbox pattern successfully holds the events and recovers without dropping a single payment.

## Security & Auth

OIDC & RBAC: Integrate an identity provider (like Keycloak for a self-hosted option, or Auth0) to handle OpenID Connect. Implement Role-Based Access Control where a USER can only query their own ledger, but a SYSTEM_ADMIN can query the aggregated dashboard statistics.
