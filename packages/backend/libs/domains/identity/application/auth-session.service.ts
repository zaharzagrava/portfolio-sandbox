import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import User, { Role } from '../infra/models/user.model';
import FederatedIdentity from '../infra/models/federated-identity.model';
import { OidcIdentity } from '../infra/oidc/oidc.service';
import type { SessionMeta } from '../domain/ports';
import { TotpService } from './mfa/totp.service';
import { IssuedSession, SessionIssuer } from './session-issuer.service';

/**
 * The S02 seams that still live here: completing a second-factor login and the OIDC login. Both end in
 * `SessionIssuer.issue`, the one place that creates sessions (password login, registration follow-up and refresh are
 * their own services). S02 owns the behaviour; S01 only owns the session it ends in.
 */
@Injectable()
export class AuthSessionService {
  constructor(
    @InjectModel(User) private readonly userModel: typeof User,
    @InjectModel(FederatedIdentity)
    private readonly identityModel: typeof FederatedIdentity,
    private readonly issuer: SessionIssuer,
    private readonly totp: TotpService,
  ) {}

  async completeMfa(
    mfaToken: string,
    code: string,
    meta: SessionMeta,
  ): Promise<IssuedSession> {
    let userId: string;
    try {
      ({ userId } = await this.issuer.verifyChallenge(mfaToken));
    } catch {
      throw new UnauthorizedException('Invalid or expired MFA challenge');
    }

    const user = await this.userModel.findByPk(userId);
    if (!user)
      throw new UnauthorizedException('Invalid or expired MFA challenge');
    const ok = /^\d{6}$/.test(code)
      ? await this.totp.verifyCode(user, code)
      : await this.totp.useRecoveryCode(user.id, code);
    if (!ok) throw new UnauthorizedException('Invalid code');
    return this.issuer.issue({ userId: user.id, amr: ['pwd', 'otp'], meta });
  }

  /**
   * OIDC login: existing (provider, subject) link → that user. Otherwise link
   * to an existing account by email ONLY if the IdP says the email is
   * verified (else anyone could register `victim@mail.com` at a lax IdP and
   * take over the account), or create a new user.
   */
  async loginWithOidc(
    identity: OidcIdentity,
    meta: SessionMeta,
  ): Promise<IssuedSession> {
    const link = await this.identityModel.findOne({
      where: { provider: identity.provider, subject: identity.subject },
    });
    let user = link ? await this.userModel.findByPk(link.userId) : null;

    if (!user) {
      if (identity.email && !identity.emailVerified)
        throw new ForbiddenException(
          'Email not verified by the identity provider',
        );
      user = identity.email
        ? await this.userModel.findOne({ where: { email: identity.email } })
        : null;
      user ??= await this.userModel.create({
        email: identity.email ?? null,
        passwordHash: null,
        role: Role.USER,
      });
      await this.identityModel.create({
        userId: user.id,
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email ?? null,
      });
    }
    return this.issuer.issue({ userId: user.id, amr: ['oidc'], meta });
  }
}
