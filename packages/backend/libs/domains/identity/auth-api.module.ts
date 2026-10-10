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
  FEDERATED_IDENTITY_REPOSITORY,
  OIDC_FLOW_STORE,
  OIDC_NET_OPTIONS,
  OIDC_PROVIDER,
  PASSWORD_HASHER,
  SESSION_REPOSITORY,
} from './domain/ports';
import { IdentitiesController } from './api/identities.controller';
import { OidcController } from './api/oidc.controller';
import { FederatedIdentityService } from './application/federated-identity.service';
import { OidcCallbackService } from './application/oidc-callback.service';
import { OidcFlowService } from './application/oidc-flow.service';
import { OidcLoginService } from './application/oidc-login.service';
import { SequelizeFederatedIdentityRepository } from './infra/models/federated-identity.repository';
import { OpenidClientProvider } from './infra/oidc/openid-client.provider';
import { RedisOidcFlowStore } from './infra/oidc/redis-flow-store';
import { AuthController } from './api/auth.controller';
import { AuthBodyLimitMiddleware } from './api/body-limit.middleware';
import { CredentialCookies } from './api/credential-cookies';
import { MfaController } from './api/mfa.controller';
import { WellKnownController } from './api/well-known.controller';
import { AccountService } from './application/account.service';
import { AuditService } from './application/audit.service';
import { LoginService } from './application/login.service';
import { MfaAttemptBudget } from './application/mfa-attempt-budget';
import { MfaLoginService } from './application/mfa-login.service';
import { RefreshService } from './application/refresh.service';
import { RegistrationService } from './application/registration.service';
import { SecondFactorService } from './application/second-factor.service';
import { SessionIssuer } from './application/session-issuer.service';
import { SessionRevocationService } from './application/session-revocation.service';
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
    {
      provide: FEDERATED_IDENTITY_REPOSITORY,
      useClass: SequelizeFederatedIdentityRepository,
    },
    { provide: OIDC_FLOW_STORE, useClass: RedisOidcFlowStore },
    { provide: OIDC_PROVIDER, useClass: OpenidClientProvider },
    // Production reaches providers over the public internet; the e2e app overrides this with the fake provider's host.
    { provide: OIDC_NET_OPTIONS, useValue: {} },
    AccountService,
    AuditService,
    CredentialCookies,
    FederatedIdentityService,
    LoginService,
    MfaAttemptBudget,
    MfaLoginService,
    OidcCallbackService,
    OidcFlowService,
    OidcLoginService,
    RefreshService,
    RegistrationService,
    SecondFactorService,
    SessionIssuer,
    SessionRevocationService,
    // Legacy engine: only tenancy's shop-SSO still registers providers on it until the registry takes over (US8).
    OidcService,
    CsrfGuard,
    AuthBodyLimitMiddleware,
  ],
  exports: [
    SecondFactorService,
    SessionIssuer,
    SessionRevocationService,
    OidcService,
  ],
  controllers: [
    AuthController,
    MfaController,
    OidcController,
    IdentitiesController,
    WellKnownController,
  ],
})
export class AuthApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthBodyLimitMiddleware)
      .forRoutes(
        AuthController,
        MfaController,
        OidcController,
        IdentitiesController,
      );
  }
}
