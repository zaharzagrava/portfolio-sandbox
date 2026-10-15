import type { InstallRecord } from './records';

export const INSTALL_REPOSITORY = Symbol('INSTALL_REPOSITORY');

export interface InstallRepository {
  /** Stores only the SHA-256 digest of the OAuth state; `expiresAt = now + 10 min`. */
  create(
    input: {
      shopId: string;
      userId: string;
      shopDomain: string;
      stateDigest: string;
    },
    now: Date,
  ): Promise<InstallRecord>;
  /** `UPDATE ... SET consumedAt WHERE consumedAt IS NULL AND expiresAt > now RETURNING`: single use. */
  consume(stateDigest: string, now: Date): Promise<InstallRecord | null>;
  /** Retention: expired more than a day ago. */
  purgeExpiredBefore(before: Date, limit: number): Promise<number>;
}
