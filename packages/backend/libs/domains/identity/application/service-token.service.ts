import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  Domain_InvalidTokenError,
  ServiceTokenRequestError,
} from '../domain/errors';
import {
  checkMintRequest,
  SERVICE_SUBJECT_PREFIX,
  SERVICE_TOKEN_TYP,
} from '../domain/service-token-policy';
import { ServiceTokenCache } from '../domain/service-token-cache';
import {
  KEY_STORE,
  REVOCATION_MARKERS,
  type KeyStorePort,
  type RevocationMarkersPort,
} from '../domain/ports';
import { TokenAuthService } from './token-auth.service';

export const DEFAULT_SERVICE_TOKEN_AUDIENCES = ['core', 'worker'];

/**
 * Service-to-service tokens (FR-070 to FR-072): signed, audience-scoped `svc+jwt` tokens of 60 s by default, so an
 * internal call proves which service it comes from without forwarding a user's access token.
 */
@Injectable()
export class ServiceTokenService {
  private cache = new ServiceTokenCache();

  /** Forgets the reusable tokens (the key set was replaced, e.g. a store reset in tests). */
  invalidate(): void {
    this.cache = new ServiceTokenCache();
  }

  constructor(
    @Inject(KEY_STORE) private readonly keys: KeyStorePort,
    private readonly tokens: TokenAuthService,
    @Inject(REVOCATION_MARKERS) private readonly markers: RevocationMarkersPort,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `sub: svc:<caller>`, no role, session or address. Tokens are reused until 80 % of their lifetime. */
  async mint(input: {
    caller: string;
    audience: string;
    ttlSec?: number;
  }): Promise<string> {
    const ttlSec = this.checked(input);
    const key = { caller: input.caller, audience: input.audience, ttlSec };
    const cached = this.cache.peek(key, this.clock.now());
    if (cached) return cached;
    const token = await this.sign(
      { sub: `${SERVICE_SUBJECT_PREFIX}${input.caller}` },
      input.audience,
      ttlSec,
    );
    return this.cache.get(key, this.clock.now(), () => ({ token }));
  }

  /**
   * A live user access token becomes a service token for `audience` that names the user (`sub`), the session and the
   * caller (`act.sub`). Never cached: it is per user. A revoked session is refused.
   */
  async exchange(input: {
    userAccessToken: string;
    caller: string;
    audience: string;
  }): Promise<string> {
    const ttlSec = this.checked(input);
    const user = await this.tokens.authenticate(input.userAccessToken);
    if (await this.markers.isRevoked(user.sessionId))
      throw new Domain_InvalidTokenError('session_revoked');
    return this.sign(
      {
        sub: user.id,
        sid: user.sessionId,
        act: { sub: `${SERVICE_SUBJECT_PREFIX}${input.caller}` },
      },
      input.audience,
      ttlSec,
    );
  }

  private checked(input: {
    caller: string;
    audience: string;
    ttlSec?: number;
  }): number {
    const result = checkMintRequest(input, this.audiences());
    if (!result.ok) throw new ServiceTokenRequestError(result.reason);
    return result.ttlSec;
  }

  private audiences(): string[] {
    const configured = (this.config.get('service_token_audiences') ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    return configured.length ? configured : DEFAULT_SERVICE_TOKEN_AUDIENCES;
  }

  private sign(
    claims: object,
    audience: string,
    expiresInSec: number,
  ): Promise<string> {
    return this.keys.sign(claims, {
      audience,
      typ: SERVICE_TOKEN_TYP,
      expiresInSec,
      jwtId: uuidv7(),
    });
  }
}
