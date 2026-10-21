/**
 * Test sharding on shared services: several test processes use ONE Kafka, ONE Elasticsearch, ONE ElasticMQ and ONE Redis
 * server, each with its own names. `TEST_SHARD` (a short id such as `1`; empty or unset = no shard) puts `s<id>-` in front
 * of every name that lives on a shared service and has no setting of its own. Production and normal runs leave it empty,
 * so every function here returns its input unchanged.
 *
 * Read from `process.env` at call time on purpose: it must be set in the shell that starts the process (scripts/infra/shard-env.sh),
 * never in `.env.test` (that file loads after some modules).
 */
const SHARD_ID = /^[a-z0-9]+$/;

export function shardId(): string {
  const id = (process.env.TEST_SHARD ?? '').trim().toLowerCase();
  if (id === '') return '';
  if (!SHARD_ID.test(id))
    throw new Error(`TEST_SHARD must be letters and digits only, got "${id}"`);
  return id;
}

/** `s1-` for shard 1, `''` without a shard. */
export function shardPrefix(): string {
  const id = shardId();
  return id === '' ? '' : `s${id}-`;
}

/** The shared-service name of this shard: `products` -> `s1-products`; unchanged without a shard. */
export function shardName(name: string): string {
  return shardPrefix() + name;
}

/** Back to the name the code knows (names read from a shared service); `undefined` when the name belongs to another shard. */
export function unshardName(name: string): string | undefined {
  const prefix = shardPrefix();
  if (prefix === '') return name;
  return name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
}
