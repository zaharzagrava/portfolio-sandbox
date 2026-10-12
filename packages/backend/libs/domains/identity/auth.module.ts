import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import User from './infra/models/user.model';
import SigningKey from './infra/models/signing-key.model';
import { KeyStore } from './infra/keys/key-store.service';
import { SecretBox } from './infra/crypto/secret-box';
import { SequelizeSigningKeyRepository } from './infra/models/signing-key.repository';
import { RevocationMarkers } from './infra/sessions/revocation-markers';
import { AuditService } from './application/audit.service';
import { KeyRotationService } from './application/key-rotation.service';
import { ServiceTokenService } from './application/service-token.service';
import { ResetTokenMaintenanceService } from './application/reset-token-maintenance.service';
import { SequelizeResetTokenRepository } from './infra/models/reset-token.repository';
import { TokenAuthService } from './application/token-auth.service';
import { AccessTokenSigner } from './application/access-token-signer.service';
import { SequelizeUserRepository } from './infra/models/user.repository';
import { UserDirectoryService } from './application/user-directory.service';
import SecondFactor from './infra/models/second-factor.model';
import MfaRecoveryCode from './infra/models/mfa-recovery-code.model';
import MfaChallengeState from './infra/models/mfa-challenge-state.model';
import { SequelizeSecondFactorRepository } from './infra/models/second-factor.repository';
import { SequelizeMfaChallengeRepository } from './infra/models/mfa-challenge.repository';
import { MfaMaintenanceService } from './application/mfa-maintenance.service';
import { OidcProviderRegistry } from './application/oidc-provider-registry';
import {
  KEY_STORE,
  MFA_CHALLENGE_REPOSITORY,
  RESET_TOKEN_REPOSITORY,
  REVOCATION_MARKERS,
  SECOND_FACTOR_REPOSITORY,
  SECRET_SEALER,
  SIGNING_KEY_REPOSITORY,
  USER_REPOSITORY,
} from './domain/ports';

/**
 * Token verification only (used by the Firewall guards everywhere). The HTTP
 * endpoints live in AuthApiModule so apps that merely *check* tokens (e.g.
 * sse-gateway) don't also expose /auth/login. Verification reads claims and the
 * cached key set; the only store it touches is the revocation marker of
 * `Firewall({ sensitive: true })` routes.
 */
@Module({
  imports: [
    SequelizeModule.forFeature([
      User,
      SigningKey,
      SecondFactor,
      MfaRecoveryCode,
      MfaChallengeState,
    ]),
    ApiConfigModule,
    ClockModule,
  ],
  providers: [
    KeyStore,
    SecretBox,
    { provide: SECRET_SEALER, useExisting: SecretBox },
    { provide: KEY_STORE, useExisting: KeyStore },
    { provide: REVOCATION_MARKERS, useExisting: RevocationMarkers },
    {
      provide: SIGNING_KEY_REPOSITORY,
      useClass: SequelizeSigningKeyRepository,
    },
    { provide: USER_REPOSITORY, useClass: SequelizeUserRepository },
    {
      provide: SECOND_FACTOR_REPOSITORY,
      useClass: SequelizeSecondFactorRepository,
    },
    {
      provide: MFA_CHALLENGE_REPOSITORY,
      useClass: SequelizeMfaChallengeRepository,
    },
    MfaMaintenanceService,
    OidcProviderRegistry,
    TokenAuthService,
    AccessTokenSigner,
    RevocationMarkers,
    UserDirectoryService,
    KeyRotationService,
    ServiceTokenService,
    {
      provide: RESET_TOKEN_REPOSITORY,
      useClass: SequelizeResetTokenRepository,
    },
    ResetTokenMaintenanceService,
    AuditService,
  ],
  exports: [
    AuditService,
    KEY_STORE,
    REVOCATION_MARKERS,
    SECRET_SEALER,
    KeyStore,
    KeyRotationService,
    ServiceTokenService,
    RESET_TOKEN_REPOSITORY,
    ResetTokenMaintenanceService,
    SecretBox,
    USER_REPOSITORY,
    SECOND_FACTOR_REPOSITORY,
    MFA_CHALLENGE_REPOSITORY,
    MfaMaintenanceService,
    OidcProviderRegistry,
    TokenAuthService,
    AccessTokenSigner,
    RevocationMarkers,
    UserDirectoryService,
  ],
})
export class AuthModule {}
