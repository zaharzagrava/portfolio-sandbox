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
import { TokenAuthService } from './application/token-auth.service';
import { AccessTokenSigner } from './application/access-token-signer.service';
import { SequelizeUserRepository } from './infra/models/user.repository';
import { UserDirectoryService } from './application/user-directory.service';
import {
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
    SequelizeModule.forFeature([User, SigningKey]),
    ApiConfigModule,
    ClockModule,
  ],
  providers: [
    KeyStore,
    SecretBox,
    { provide: SECRET_SEALER, useExisting: SecretBox },
    {
      provide: SIGNING_KEY_REPOSITORY,
      useClass: SequelizeSigningKeyRepository,
    },
    { provide: USER_REPOSITORY, useClass: SequelizeUserRepository },
    TokenAuthService,
    AccessTokenSigner,
    RevocationMarkers,
    UserDirectoryService,
  ],
  exports: [
    KeyStore,
    SecretBox,
    USER_REPOSITORY,
    TokenAuthService,
    AccessTokenSigner,
    RevocationMarkers,
    UserDirectoryService,
  ],
})
export class AuthModule {}
