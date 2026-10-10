import * as argon2 from 'argon2';
import * as bcrypt from 'bcrypt';
import { PasswordHasher } from './password-hasher';

describe('S01 AS-17: password hasher', () => {
  const hasher = new PasswordHasher();
  const password = 'correct horse battery staple';

  it('hashes with Argon2id and verifies without a rehash', async () => {
    const hash = await hasher.hash(password);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(hasher.verify(password, hash)).resolves.toEqual({
      valid: true,
      needsRehash: false,
    });
    await expect(hasher.verify('wrong password!!', hash)).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('verifies a legacy bcrypt hash and asks for a rehash', async () => {
    const legacy = await bcrypt.hash(password, 4);
    await expect(hasher.verify(password, legacy)).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
    await expect(hasher.verify('nope nope nope', legacy)).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('asks for a rehash when the Argon2 parameters are older than the current ones', async () => {
    const old = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 4096,
      timeCost: 2,
      parallelism: 1,
    });
    await expect(hasher.verify(password, old)).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
  });

  it.each([null, undefined, ''])(
    'a missing hash (%p) is invalid, spends one verification and never throws',
    async (hash) => {
      await expect(hasher.verify(password, hash)).resolves.toEqual({
        valid: false,
        needsRehash: false,
      });
    },
  );

  it.each([
    '$argon2id$garbage',
    '$argon2id$v=19$m=19456,t=2,p=1$bad$bad',
    '$2b$10$short',
    'plain text, not a hash',
    '$unknown$x$y',
  ])('a malformed hash (%s) is invalid and never throws', async (hash) => {
    await expect(hasher.verify(password, hash)).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });
});
