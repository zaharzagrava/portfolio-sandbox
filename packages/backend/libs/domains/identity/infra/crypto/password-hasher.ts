import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as bcrypt from 'bcrypt';

/**
 * Argon2id (memory-hard: GPU/ASIC cracking is expensive) for new hashes; the
 * existing bcrypt hashes keep working and are upgraded transparently on the
 * next successful login ("rehash on verify") - no forced password reset.
 * Parameters follow OWASP's baseline (m=19 MiB, t=2, p=1); argon2's native
 * code runs on the libuv thread pool, so it doesn't block the event loop.
 */
@Injectable()
export class PasswordHasher {
  private readonly options = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  /** A real hash compared against when the user doesn't exist → constant-ish timing, no user enumeration. */
  private readonly dummy = argon2.hash('timing-equalizer', this.options);

  hash(password: string): Promise<string> {
    return argon2.hash(password, this.options);
  }

  async verify(
    password: string,
    hash: string | null | undefined,
  ): Promise<{ valid: boolean; needsRehash: boolean }> {
    if (!hash) {
      await argon2.verify(await this.dummy, password).catch(() => false);
      return { valid: false, needsRehash: false };
    }
    if (hash.startsWith('$argon2')) {
      const valid = await argon2.verify(hash, password);
      return {
        valid,
        needsRehash: valid && argon2.needsRehash(hash, this.options),
      };
    }
    // Legacy bcrypt ($2a$/$2b$)
    const valid = await bcrypt.compare(password, hash);
    return { valid, needsRehash: valid };
  }
}
