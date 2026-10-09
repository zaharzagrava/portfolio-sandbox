import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import User from './infra/models/user.model';
import FederatedIdentity from './infra/models/federated-identity.model';
import { ApiConfigModule } from '@app/common/config';
import { AuthModule } from './auth.module';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { AuthController } from './api/auth.controller';
import { WellKnownController } from './api/well-known.controller';
import { AuthSessionService } from './application/auth-session.service';
import { PasswordHasher } from './infra/crypto/password-hasher';
import { SessionStore } from './infra/sessions/session-store.service';
import { TotpService } from './application/mfa/totp.service';
import { OidcService } from './infra/oidc/oidc.service';
import { CsrfGuard } from './api/guards/csrf.guard';
import { SessionNotRevokedGuard } from './api/guards/session-not-revoked.guard';

/**
 * Login/session endpoints (SD-39). Needs the global Redis, Dynamo and Cache
 * modules in the hosting app (core).
 */
@Module({
  imports: [
    AuthModule,
    ApiConfigModule,
    RateLimitModule,
    DynamoModule,
    SequelizeModule.forFeature([User, FederatedIdentity]),
  ],
  providers: [
    AuthSessionService,
    PasswordHasher,
    SessionStore,
    TotpService,
    OidcService,
    CsrfGuard,
    SessionNotRevokedGuard,
  ],
  exports: [
    AuthSessionService,
    SessionStore,
    SessionNotRevokedGuard,
    OidcService,
  ],
  controllers: [AuthController, WellKnownController],
})
export class AuthApiModule {}
