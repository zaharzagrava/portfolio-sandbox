import { Module } from '@nestjs/common';
import { AuthService } from './application/auth.service';
import User from './infra/models/user.model';
import SigningKey from './infra/models/signing-key.model';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config';
import { KeyStore } from './infra/keys/key-store.service';
import { SecretBox } from './infra/crypto/secret-box';

/**
 * Token verification only (used by the Firewall guards everywhere). The HTTP
 * endpoints live in AuthApiModule so apps that merely *check* tokens (e.g.
 * sse-gateway) don't also expose /auth/login.
 */
@Module({
  imports: [SequelizeModule.forFeature([User, SigningKey]), ApiConfigModule],
  providers: [AuthService, KeyStore, SecretBox],
  exports: [AuthService, KeyStore, SecretBox],
})
export class AuthModule {}
