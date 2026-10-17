import { Inject, Injectable } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { v7 as uuidv7 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { DRAFT_LIMITS } from '../domain/draft-limits';
import { TICKET_ID_STORE, type TicketIdStore } from '../domain/draft-ports';

export const TICKET_ISSUER = 'marketplace-collab';

export interface TicketClaims {
  userId: string;
  shopId: string;
  draftId: string;
  canWrite: boolean;
  jti: string;
}

/**
 * Editing tickets (S06 FR-009). A ticket lives 60 seconds, is signed with a key and an audience dedicated to
 * collaboration (never the session key), pins `HS256`, and is accepted once. Verifying does not consume it; the connection
 * server consumes the `jti` only after the join passed every other check.
 */
@Injectable()
export class DraftTicketService {
  constructor(
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TICKET_ID_STORE) private readonly ids: TicketIdStore,
  ) {}

  private key(): string {
    const key = this.config.get('collab_ticket_key');
    if (!key) throw new Error('collab_ticket_key is not configured');
    return key;
  }

  issue(claims: Omit<TicketClaims, 'jti'>): {
    ticket: string;
    expiresAt: Date;
  } {
    const iat = Math.floor(this.clock.nowMs() / 1000);
    const exp = iat + DRAFT_LIMITS.ticketTtlSeconds;
    const ticket = jwt.sign(
      {
        iss: TICKET_ISSUER,
        aud: `collab:${claims.draftId}`,
        sub: claims.userId,
        shop: claims.shopId,
        draft: claims.draftId,
        w: claims.canWrite,
        jti: uuidv7(),
        iat,
        exp,
      },
      this.key(),
      { algorithm: 'HS256' },
    );
    return { ticket, expiresAt: new Date(exp * 1000) };
  }

  /** The claims of a valid ticket for exactly this draft, or `null` (expired, other key or algorithm, issuer, audience). */
  verify(token: string, draftId: string): TicketClaims | null {
    try {
      const claims = jwt.verify(token, this.key(), {
        algorithms: ['HS256'],
        issuer: TICKET_ISSUER,
        audience: `collab:${draftId}`,
        clockTimestamp: Math.floor(this.clock.nowMs() / 1000),
      }) as jwt.JwtPayload;
      if (
        typeof claims.sub !== 'string' ||
        typeof claims.shop !== 'string' ||
        claims.draft !== draftId ||
        typeof claims.jti !== 'string'
      )
        return null;
      return {
        userId: claims.sub,
        shopId: claims.shop,
        draftId,
        canWrite: claims.w === true,
        jti: claims.jti,
      };
    } catch {
      return null;
    }
  }

  /** `true` for the first caller; an already used ticket gives `false`. Throws when the store cannot answer. */
  consume(jti: string): Promise<boolean> {
    return this.ids.consume(jti, DRAFT_LIMITS.ticketTtlSeconds);
  }
}
