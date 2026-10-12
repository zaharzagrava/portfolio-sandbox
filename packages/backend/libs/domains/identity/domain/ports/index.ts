import type { KeyObject } from 'node:crypto';
import type { Role } from '../role';

/**
 * Domain ports (D-6): `api/` and `application/` depend on these tokens; adapters live in `infra/` and are bound in
 * the module. Each token is a Symbol so a swap in a test is one `overrideProvider`.
 */

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');
export const SIGNING_KEY_REPOSITORY = Symbol('SIGNING_KEY_REPOSITORY');
export const RESET_TOKEN_REPOSITORY = Symbol('RESET_TOKEN_REPOSITORY');
export const PASSWORD_RESET_MAILER = Symbol('PASSWORD_RESET_MAILER');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

/**
 * Hands the reset link to the mail channel. Implemented by the notifications domain (identity may not import it) and
 * sent directly, not through the outbox: the raw token must never be stored (W01 B-4).
 */
export interface PasswordResetMailer {
  sendResetLink(input: {
    to: string;
    link: string;
    expiresAt: Date;
  }): Promise<void>;
}

export interface ResetTokenRepository {
  /** Invalidates the user's older unused tokens and stores the new digest (one statement pair, joins the active transaction). */
  issue(input: {
    userId: string;
    digest: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void>;
  /** The owner of an unused, unexpired token, without spending it. */
  find(digest: string, now: Date): Promise<string | null>;
  /** Spends the token; `false` for exactly the losers of a race, unknown, used or expired tokens. */
  consume(digest: string, now: Date): Promise<boolean>;
  /** Deletes up to `limit` tokens that expired before `before`; returns how many (bounded batch, idempotent). */
  purgeExpired(before: Date, limit: number): Promise<number>;
}
export const SECRET_SEALER = Symbol('SECRET_SEALER');
export const BREACH_CHECKER = Symbol('BREACH_CHECKER');
export const SECOND_FACTOR_REPOSITORY = Symbol('SECOND_FACTOR_REPOSITORY');
export const MFA_CHALLENGE_REPOSITORY = Symbol('MFA_CHALLENGE_REPOSITORY');
export const FEDERATED_IDENTITY_REPOSITORY = Symbol(
  'FEDERATED_IDENTITY_REPOSITORY',
);
export const OIDC_FLOW_STORE = Symbol('OIDC_FLOW_STORE');
export const OIDC_PROVIDER = Symbol('OIDC_PROVIDER');
export const OIDC_NET_OPTIONS = Symbol('OIDC_NET_OPTIONS');

export interface UserRecord {
  id: string;
  email: string | null;
  passwordHash: string | null;
  role: Role;
  createdAt: Date;
}

/** A user as the linking decision sees it: soft-deleted rows included. */
export interface UserLookup {
  id: string;
  email: string | null;
  hasPassword: boolean;
  deleted: boolean;
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
  /** Sets the hash unconditionally (password reset, where the token is the proof); `false` for a missing or deleted user. */
  setPasswordHash(id: string, newHash: string): Promise<boolean>;
  /** Removes the password (account linking wipe); `false` when there was none. Conditional on `passwordHash IS NOT NULL`. */
  clearPassword(id: string): Promise<boolean>;
  /** `USER` → `SELLER` in one conditional update (`WHERE role = 'USER'`); `false` when the user is missing, deleted or already above `USER`. */
  promoteToSeller(id: string): Promise<boolean>;
  /** The user with this (trimmed, lower-cased) address, soft-deleted users included. */
  lookupByEmail(email: string): Promise<UserLookup | null>;
  /** A user created by a federated login: no password, `email` null or a verified address. `null` when the address is taken. */
  insertFederated(input: {
    email: string | null;
    role: Role;
  }): Promise<{ id: string } | null>;
}

export type SecondFactorRow = {
  userId: string;
  state: 'pending' | 'enabled';
  secretSealed: string;
  /** 0 = sealed without context (migrated), 1 = bound to `mfa:<userId>`. */
  sealVersion: number;
  pendingExpiresAt: Date | null;
  enabledAt: Date | null;
  lastStep: number | null;
};

/**
 * The only reader and writer of the second-factor tables (III.1). Every state change is one conditional statement;
 * the methods join the active transaction (CLS) when there is one.
 */
export interface SecondFactorRepository {
  /** `pending` rows past their expiry read as absent. */
  find(userId: string, now: Date): Promise<SecondFactorRow | null>;
  /** Creates or replaces a pending enrolment; `false` when the factor is `enabled` (nothing changed). */
  enrol(input: {
    userId: string;
    secretSealed: string;
    expiresAt: Date;
    now: Date;
  }): Promise<boolean>;
  /** `pending → enabled`, recording the accepted step; `false` when no live pending row was moved. */
  confirm(userId: string, step: number, now: Date): Promise<boolean>;
  /** Raises `lastStep` to `step` for an `enabled` factor; `false` when the step is not newer (replay). */
  acceptStep(userId: string, step: number, now: Date): Promise<boolean>;
  /** Deletes the user's codes and stores the new digests. */
  replaceCodes(userId: string, digests: string[], now: Date): Promise<void>;
  /** `true` for exactly one caller per code. */
  spendCode(userId: string, digest: string, now: Date): Promise<boolean>;
  remainingCodes(userId: string): Promise<number>;
  /** `enabled → none`: removes the row and the codes; `false` when it was not enabled. */
  disable(userId: string): Promise<boolean>;
  /** Removes the row (any state) and the codes; returns the state it had, `null` when there was none. */
  deleteAll(userId: string): Promise<'pending' | 'enabled' | null>;
  /** Re-seals rows with `sealVersion = 0`; returns how many were done. */
  resealBatch(
    limit: number,
    reseal: (row: SecondFactorRow) => string,
    now: Date,
  ): Promise<number>;
  /** Removes `pending` rows expired before `before`. */
  purgePending(before: Date, limit: number): Promise<number>;
}

export interface MfaChallengeRepository {
  /**
   * Reserves one attempt on the challenge before a code is compared: the attempt count after reserving, or `null`
   * when the challenge is spent or already used its `max` attempts.
   */
  reserveAttempt(input: {
    jti: string;
    userId: string;
    expiresAt: Date;
    max: number;
  }): Promise<number | null>;
  /** Marks the challenge spent; `false` when another request won. */
  spend(jti: string, now: Date): Promise<boolean>;
  purge(before: Date, limit: number): Promise<number>;
}

export type FederatedIdentityRecord = {
  id: string;
  userId: string;
  provider: string;
  subject: string;
  /** A hint copied from the provider's claim, never a key and never proof of ownership. */
  email: string | null;
  wipePending: boolean;
  createdAt: Date;
};

export interface FederatedIdentityRepository {
  /** The owner's soft-delete state comes with the row. */
  findByProviderSubject(
    provider: string,
    subject: string,
  ): Promise<(FederatedIdentityRecord & { userDeleted: boolean }) | null>;
  findByUserProvider(
    userId: string,
    provider: string,
  ): Promise<FederatedIdentityRecord | null>;
  listForUser(userId: string): Promise<FederatedIdentityRecord[]>;
  /** `null` when a unique index refused it (the caller re-reads and re-decides). Refuses an unknown provider shape. */
  insert(input: {
    userId: string;
    provider: string;
    subject: string;
    email: string | null;
    wipePending: boolean;
  }): Promise<FederatedIdentityRecord | null>;
  /** Predicate carries the caller; `null` for another user's, unknown or deleted id. */
  deleteOwned(id: string, userId: string): Promise<{ provider: string } | null>;
  /** Login methods the user has: federated identities + 1 for a password. */
  countLoginMethods(userId: string): Promise<number>;
  markWipeDone(id: string): Promise<boolean>;
}

export interface OidcFlow {
  provider: string;
  purpose: 'login' | 'link';
  userId?: string;
  verifier: string;
  nonce: string;
  returnPath: string;
  /** SHA-256 of the value in the browser's flow cookie. */
  cookieDigest: string;
}

export interface OidcFlowStore {
  put(stateDigest: string, flow: OidcFlow, ttlSec: number): Promise<void>;
  /** Atomic: exactly one caller gets the flow. */
  consume(stateDigest: string): Promise<OidcFlow | undefined>;
}

export interface OidcProviderSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

export type OidcProviderFailure = 'unavailable' | 'exchange' | 'token';

/** Thrown by the provider adapter; carries a kind only, never provider text. */
export class OidcProviderError extends Error {
  constructor(
    readonly kind: OidcProviderFailure,
    readonly timeout = false,
    /** The SSRF guard refused the target (scheme, port, address, redirect): the issuer is not one we may call. */
    readonly refused = false,
  ) {
    super(`oidc provider: ${kind}`);
    this.name = 'OidcProviderError';
  }
}

export interface OidcProviderPort {
  /** Drops whatever is cached about a provider (a changed configuration). */
  invalidate(providerId: string): void;
  authorizationUrl(
    provider: string,
    settings: OidcProviderSettings,
    input: {
      state: string;
      nonce: string;
      challenge: string;
      redirectUri: string;
    },
  ): Promise<string>;
  /** Exchanges the callback's code and returns the claims of the verified ID token. */
  exchange(
    provider: string,
    settings: OidcProviderSettings,
    input: {
      code: string;
      state: string;
      verifier: string;
      nonce: string;
      redirectUri: string;
    },
  ): Promise<Record<string, unknown>>;
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
  /** The session a refresh token belongs to (spent or not), read-only; `undefined` for an unknown token. */
  sidOfRefreshToken(refreshToken: string): Promise<string | undefined>;
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
  /** ACTIVE → RETIRED, only if it still is ACTIVE; `false` when another run got there first. Joins the active transaction. */
  retire(kid: string, now: Date): Promise<boolean>;
  /** NEXT → ACTIVE, only if it still is NEXT. Joins the active transaction. */
  activate(kid: string, now: Date): Promise<boolean>;
  /** Deletes a RETIRED key; `false` when it is gone or no longer RETIRED. */
  purge(kid: string): Promise<boolean>;
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
  /** Deterministic keyed digest for values that are compared, not recovered (recovery codes). */
  keyedDigest(purpose: string, value: string): string;
}

export const KEY_STORE = Symbol('KEY_STORE');
export const REVOCATION_MARKERS = Symbol('REVOCATION_MARKERS');

export interface SignOptions {
  expiresInSec: number;
  audience?: string;
  /** JOSE `typ` header (`at+jwt`, `mfa+jwt`, `svc+jwt`); omitted = a plain JWT. */
  typ?: string;
  jwtId?: string;
}

/** The rotating signing keys: signing with the ACTIVE key, verification keys by `kid`, the public key set. */
export interface KeyStorePort {
  sign(payload: object, options: SignOptions): Promise<string>;
  verificationKey(
    kid: string,
  ): Promise<{ key: KeyObject; alg: 'ES256' } | undefined>;
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
  /** `null` when another instance created the ACTIVE/NEXT key first. */
  createKey(status?: 'NEXT' | 'ACTIVE'): Promise<string | null>;
  /** Drops the in-process key cache. */
  invalidate(): void;
}

/** Session-revoked markers for instant revocation on sensitive routes (FR-025). */
export interface RevocationMarkersPort {
  mark(sid: string, reason: string): Promise<void>;
  /** Throws when the store is unreachable: callers on sensitive routes fail closed. */
  isRevoked(sid: string): Promise<boolean>;
}

export interface BreachCheckerPort {
  /** Resolves `true` only when the corpus says so; the adapter turns timeouts and errors into `false` plus a counter. */
  isBreached(password: string): Promise<boolean>;
}
