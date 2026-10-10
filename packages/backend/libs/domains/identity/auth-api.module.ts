import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import User from './infra/models/user.model';
import FederatedIdentity from './infra/models/federated-identity.model';
import { ApiConfigModule } from '@app/common/config';
import { AuthModule } from './auth.module';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { identityRatePolicies } from './domain/auth-rate-policies';
import { IDENTITY_AGGREGATE } from './domain/events';
import {
  BREACH_CHECKER,
  PASSWORD_HASHER,
  SESSION_REPOSITORY,
} from './domain/ports';
import { AuthController } from './api/auth.controller';
import { AuthBodyLimitMiddleware } from './api/body-limit.middleware';
import { WellKnownController } from './api/well-known.controller';
import { AccountService } from './application/account.service';
import { AuditService } from './application/audit.service';
import { AuthSessionService } from './application/auth-session.service';
import { LoginService } from './application/login.service';
import { RefreshService } from './application/refresh.service';
import { RegistrationService } from './application/registration.service';
import { SessionIssuer } from './application/session-issuer.service';
import { SessionRevocationService } from './application/session-revocation.service';
import { TotpService } from './application/mfa/totp.service';
import { RangeBreachChecker } from './infra/breach/range-breach-checker';
import { PasswordHasher } from './infra/crypto/password-hasher';
import { DynamoSessionRepository } from './infra/sessions/dynamo-session.repository';
import { OidcService } from './infra/oidc/oidc.service';
import { CsrfGuard } from './api/guards/csrf.guard';

/**
 * Login/session endpoints (SD-39). Needs the global Redis, Dynamo and Cache
 * modules in the hosting app (core), and `RateLimitModule.forRoot()` there for
 * the `@RateLimit` routes to be enforced.
 */
@Module({
  imports: [
    AuthModule,
    ApiConfigModule,
    RateLimitModule,
    RateLimitModule.forFeature(identityRatePolicies),
    DynamoModule,
    EventsModule.forAggregates([IDENTITY_AGGREGATE]),
    SequelizeModule.forFeature([User, FederatedIdentity]),
  ],
  providers: [
    { provide: SESSION_REPOSITORY, useClass: DynamoSessionRepository },
    { provide: PASSWORD_HASHER, useClass: PasswordHasher },
    { provide: BREACH_CHECKER, useClass: RangeBreachChecker },
    AccountService,
    AuditService,
    AuthSessionService,
    LoginService,
    RefreshService,
    RegistrationService,
    SessionIssuer,
    SessionRevocationService,
    TotpService,
    OidcService,
    CsrfGuard,
    AuthBodyLimitMiddleware,
  ],
  exports: [
    AuthSessionService,
    SessionIssuer,
    SessionRevocationService,
    OidcService,
  ],
  controllers: [AuthController, WellKnownController],
})
export class AuthApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(AuthBodyLimitMiddleware).forRoutes(AuthController);
  }
}
