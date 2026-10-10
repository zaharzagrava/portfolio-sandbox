import type { Role } from '../../infra/models/user.model';

/**
 * Domain ports (D-6): `api/` and `application/` depend on these tokens; adapters live in `infra/` and are bound in
 * the module. Each token is a Symbol so a swap in a test is one `overrideProvider`.
 */

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');
export const SIGNING_KEY_REPOSITORY = Symbol('SIGNING_KEY_REPOSITORY');
export const RESET_TOKEN_REPOSITORY = Symbol('RESET_TOKEN_REPOSITORY');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export const SECRET_SEALER = Symbol('SECRET_SEALER');
export const BREACH_CHECKER = Symbol('BREACH_CHECKER');

export interface UserRecord {
  id: string;
  email: string | null;
  passwordHash: string | null;
  role: Role;
  mfaEnabled: boolean;
  createdAt: Date;
}

export interface UserRepository {
  /** `email` is already trimmed and lower-cased. */
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** One read; soft-deleted users are not returned. */
  findByIds(ids: string[]): Promise<UserRecord[]>;
  /** One statement against the `lower(email)` unique index; `created: false` returns the existing id. */
  insertIfAbsent(input: {
    email: string;
    passwordHash: string;
    role: Role;
  }): Promise<{ id: string; created: boolean }>;
  /** Conditional on the old hash: no lost update if the password changed meanwhile. */
  replacePasswordHash(
    id: string,
    oldHash: string,
    newHash: string,
  ): Promise<boolean>;
}

export interface SessionMeta {
  device?: string;
  ip?: string;
}

export interface SessionRecord {
  sid: string;
  userId: string;
  familyId: string;
  device?: string;
  ip?: string;
  /** Authentication methods the session was created with (`pwd`, `otp`, ...); carried into every access token. */
  amr?: string[];
  createdAt: string;
  lastUsedAt?: string;
  /** Epoch seconds: the session cannot be refreshed past this, however often it is used. */
  absoluteExpiry: number;
  revokedAt?: string;
  revokeReason?: string;
}

export type RotateOutcome =
  | { ok: true; session: SessionRecord; refreshToken: string }
  | {
      ok: false;
      reason: 'unknown' | 'expired' | 'revoked' | 'reuse';
      /** The session the presented token belonged to, when it was a known one. */
      sid?: string;
      userId?: string;
    };

export interface SessionRepository {
  /** Stores the session and its first refresh-token digest. */
  create(input: {
    sid: string;
    userId: string;
    amr: string[];
    meta: SessionMeta;
    now: Date;
  }): Promise<{ session: SessionRecord; refreshToken: string }>;
  /** One atomic write: spend the old digest, store the successor, assert the session is not revoked. */
  rotate(refreshToken: string, now: Date): Promise<RotateOutcome>;
  get(sid: string): Promise<SessionRecord | undefined>;
  listForUser(userId: string): Promise<SessionRecord[]>;
  /** Durable revoke, idempotent; the first reason wins. */
  revoke(sid: string, reason: string, now: Date): Promise<void>;
}

export interface SigningKeyRow {
  kid: string;
  status: 'NEXT' | 'ACTIVE' | 'RETIRED';
  publicJwk: Record<string, unknown>;
  privateKeySealed: string;
  activatedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
}

export interface SigningKeyRepository {
  list(): Promise<SigningKeyRow[]>;
  /** `false` when a unique index refused it (another instance won the bootstrap race); any other error throws. */
  insert(row: Omit<SigningKeyRow, 'retiredAt'>): Promise<boolean>;
}

export interface PasswordHasherPort {
  hash(password: string): Promise<string>;
  verify(
    password: string,
    hash: string | null | undefined,
  ): Promise<{ valid: boolean; needsRehash: boolean }>;
}

export interface SecretSealerPort {
  seal(plaintext: string, context?: string): string;
  open(sealed: string, context?: string): string;
}

export interface BreachCheckerPort {
  /** Resolves `true` only when the corpus says so; the adapter turns timeouts and errors into `false` plus a counter. */
  isBreached(password: string): Promise<boolean>;
}
