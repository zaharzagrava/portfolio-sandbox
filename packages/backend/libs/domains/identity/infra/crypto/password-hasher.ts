import { Injectable, Optional } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as bcrypt from 'bcrypt';
import { ConfigRules } from '@app/common/config/config-rules';
import {
  BoundedConcurrency,
  hashConcurrencyProblems,
} from '../../domain/bounded-concurrency';
import type { PasswordHasherPort } from '../../domain/ports';

export const HASH_CONCURRENCY = 4;
export const HASH_QUEUE = 64;

ConfigRules.register({
  owner: 'identity',
  keys: ['UV_THREADPOOL_SIZE'],
  validate: (ctx) =>
    hashConcurrencyProblems(
      HASH_CONCURRENCY,
      process.env.UV_THREADPOOL_SIZE
        ? Number(process.env.UV_THREADPOOL_SIZE)
        : undefined,
      ctx.production,
    ),
});

/**
 * Argon2id (memory-hard: GPU/ASIC cracking is expensive) for new hashes; the
 * existing bcrypt hashes keep working and are upgraded transparently on the
 * next successful login ("rehash on verify") - no forced password reset.
 * Parameters follow OWASP's baseline (m=19 MiB, t=2, p=1); argon2's native
 * code runs on the libuv thread pool, so it doesn't block the event loop, and
 * `BoundedConcurrency` keeps it from taking the whole pool.
 */
@Injectable()
export class PasswordHasher implements PasswordHasherPort {
  private readonly options = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  /** A real hash compared against when the user doesn't exist → constant-ish timing, no user enumeration. */
  private dummy?: Promise<string>;

  constructor(
    @Optional()
    private readonly gate: BoundedConcurrency = new BoundedConcurrency(
      HASH_CONCURRENCY,
      HASH_QUEUE,
    ),
  ) {}

  hash(password: string): Promise<string> {
    return this.gate.run(() => argon2.hash(password, this.options));
  }

  async verify(
    password: string,
    hash: string | null | undefined,
  ): Promise<{ valid: boolean; needsRehash: boolean }> {
    if (!hash) {
      this.dummy ??= argon2.hash('timing-equalizer', this.options);
      const dummy = await this.dummy;
      await this.gate.run(() =>
        argon2.verify(dummy, password).catch(() => false),
      );
      return { valid: false, needsRehash: false };
    }
    try {
      if (hash.startsWith('$argon2')) {
        const valid = await this.gate.run(() => argon2.verify(hash, password));
        return {
          valid,
          needsRehash: valid && argon2.needsRehash(hash, this.options),
        };
      }
      // Legacy bcrypt ($2a$/$2b$); anything else fails to compare and is simply invalid.
      const valid = await this.gate.run(() => bcrypt.compare(password, hash));
      return { valid, needsRehash: valid };
    } catch (error) {
      // Overload must reach the caller (503); a malformed hash is just "not valid".
      if (error instanceof Error && error.name === 'Domain_OverloadedError')
        throw error;
      return { valid: false, needsRehash: false };
    }
  }
}
