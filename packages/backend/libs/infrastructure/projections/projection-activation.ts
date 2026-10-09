import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';

export class NoPreviousVersionError extends Error {
  constructor(readonly name_: string) {
    super(`Projection "${name_}" has no previous version to roll back to`);
    this.name = 'NoPreviousVersionError';
  }
}

/** Points the active label at a new version and remembers the old one, in one atomic step. */
const SWITCH = `
local old = redis.call('GET', KEYS[1])
if old then redis.call('SET', KEYS[2], old) end
redis.call('SET', KEYS[1], ARGV[1])
return old
`;

/** Swaps the active and the previous label: after it, reads use what they used before the last switch. */
const ROLLBACK = `
local previous = redis.call('GET', KEYS[2])
if not previous then return false end
local current = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], previous)
if current then redis.call('SET', KEYS[2], current) end
return previous
`;

/**
 * Which version of a projection reads use (S53 FR-052, R-11): `projection:active:{name}` holds a label (`v1`, `v2`),
 * `...:previous` the one before. A shadow rebuild fills a new target under its own consumer group; promotion flips
 * the label with one atomic write, so a read sees the old target or the new one, never a half-built one, and the
 * old version keeps applying events so a rollback finds it current.
 */
@Injectable()
export class ProjectionActivation {
  constructor(private readonly redis: RedisService) {}

  private keys(name: string): [string, string] {
    return [`projection:active:${name}`, `projection:active:${name}:previous`];
  }

  async active(name: string): Promise<string | null> {
    return this.redis.client.get(this.keys(name)[0]);
  }

  async previous(name: string): Promise<string | null> {
    return this.redis.client.get(this.keys(name)[1]);
  }

  async switchTo(name: string, label: string): Promise<void> {
    await this.redis.client.eval(SWITCH, 2, ...this.keys(name), label);
  }

  /** Returns the label that is active afterwards. */
  async rollback(name: string): Promise<string> {
    const previous = (await this.redis.client.eval(
      ROLLBACK,
      2,
      ...this.keys(name),
    )) as string | false;
    if (!previous) throw new NoPreviousVersionError(name);
    return previous;
  }
}
