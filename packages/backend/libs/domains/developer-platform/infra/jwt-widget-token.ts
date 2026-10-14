import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { ApiConfigService } from '@app/common/config';
import {
  HandoffVerifier,
  WidgetTokenClaims,
  WidgetTokenSigner,
} from '../domain/widget-ports';

export const WIDGET_TOKEN_TYP = 'widget+jwt';
export const WIDGET_TOKEN_AUDIENCE = 'marketplace-widget-session';
export const WIDGET_TOKEN_ISSUER = 'marketplace';

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const int = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v);

/**
 * The widget session token (FR-020): HS256 under `widget_token_key`, a key no other verifier holds, with its own type,
 * audience and issuer, so it is refused by the access-token verifier and refuses theirs (AS-33). Time is passed in.
 */
@Injectable()
export class JwtWidgetTokenSigner extends WidgetTokenSigner {
  private readonly key: string;

  constructor(config: ApiConfigService) {
    super();
    this.key = config.get('widget_token_key');
    if (!this.key || Buffer.byteLength(this.key) < 32)
      throw new Error('widget_token_key is required (at least 32 bytes)');
  }

  sign(input: {
    siteId: string;
    shopId: string;
    externalCustomerId: string;
    email: string | null;
    now: Date;
    lifetimeSeconds: number;
  }): { token: string; claims: WidgetTokenClaims } {
    const iat = Math.floor(input.now.getTime() / 1000);
    const exp = iat + input.lifetimeSeconds;
    const jti = randomUUID();
    const token = jwt.sign(
      {
        typ: WIDGET_TOKEN_TYP,
        site: input.siteId,
        shop: input.shopId,
        ext: input.externalCustomerId,
        email: input.email,
        jti,
        iat,
        exp,
      },
      this.key,
      {
        algorithm: 'HS256',
        audience: WIDGET_TOKEN_AUDIENCE,
        issuer: WIDGET_TOKEN_ISSUER,
        header: { alg: 'HS256', typ: WIDGET_TOKEN_TYP },
      },
    );
    return {
      token,
      claims: {
        jti,
        siteId: input.siteId,
        shopId: input.shopId,
        externalCustomerId: input.externalCustomerId,
        email: input.email,
        issuedAt: iat,
        expiresAt: exp,
      },
    };
  }

  verify(token: string, now: Date): WidgetTokenClaims | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096)
      return null;
    try {
      const decoded = jwt.verify(token, this.key, {
        algorithms: ['HS256'],
        audience: WIDGET_TOKEN_AUDIENCE,
        issuer: WIDGET_TOKEN_ISSUER,
        clockTimestamp: Math.floor(now.getTime() / 1000),
        complete: true,
      });
      const payload = decoded.payload as jwt.JwtPayload;
      if (decoded.header.typ !== WIDGET_TOKEN_TYP) return null;
      if (payload.typ !== WIDGET_TOKEN_TYP) return null;
      if (
        !str(payload.jti) ||
        !str(payload.site) ||
        !str(payload.shop) ||
        !str(payload.ext) ||
        !int(payload.iat) ||
        !int(payload.exp)
      )
        return null;
      return {
        jti: payload.jti,
        siteId: payload.site as string,
        shopId: payload.shop as string,
        externalCustomerId: payload.ext as string,
        email: typeof payload.email === 'string' ? payload.email : null,
        issuedAt: payload.iat,
        expiresAt: payload.exp,
      };
    } catch {
      return null;
    }
  }
}

/** HS256 pinned: any other algorithm, `none` and algorithm-confusion tokens fail here, before any claim is read (AS-25). */
@Injectable()
export class JwtHandoffVerifier extends HandoffVerifier {
  verify(token: string, secret: string): Record<string, unknown> | null {
    try {
      const payload = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        // time is judged by the claims policy against the injected clock, not by the library
        ignoreExpiration: true,
        ignoreNotBefore: true,
      });
      return typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
