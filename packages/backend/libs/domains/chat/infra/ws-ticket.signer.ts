import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { ApiConfigService } from '@app/common/config';
import {
  CHAT_WS_TICKET_TTL_SECONDS,
  CHAT_WS_TICKET_TYPE,
} from '../domain/chat.constants';
import type { TicketSigner } from '../domain/ports';

/**
 * The credential the Rust chat-gateway verifies (packages/hft-platform/src/auth.rs): HS256 with the shared `JWT_SECRET`,
 * claims `sub` (the user) and `typ: "ws"`, which an API access token never carries, so the two cannot be swapped.
 * `iat` and `exp` come from the injected clock (R-16), not from the signer's own.
 */
@Injectable()
export class JwtWsTicketSigner implements TicketSigner {
  constructor(private readonly config: ApiConfigService) {}

  sign(userId: string, now: Date) {
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + CHAT_WS_TICKET_TTL_SECONDS;
    const ticket = jwt.sign(
      { sub: userId, typ: CHAT_WS_TICKET_TYPE, iat, exp },
      this.config.get('jwt_secret'),
      { algorithm: 'HS256' },
    );
    return {
      ticket,
      wsUrl: this.config.get('chat_ws_url'),
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }
}
