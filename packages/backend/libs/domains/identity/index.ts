/**
 * Public entry point of the `identity` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/identity`. Generated from actual cross-domain usage in Phase 2; extend it by
 * hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { default as FederatedIdentityModel } from './infra/models/federated-identity.model';
export { default as SigningKeyModel } from './infra/models/signing-key.model';
export { Role, default as UserModel } from './infra/models/user.model';
export { AdminModule } from './admin.module';
export { AuthApiModule } from './auth-api.module';
export { AuthWorkerModule } from './auth-worker.module';
export { AuthModule } from './auth.module';
export { UserUtilsModule } from './user-utils.module';
export { UsersDtoModule } from './users-dto.module';
export { UsersModule } from './users.module';
export { Firewall } from './api/decorators/firewall.decorator';
export { User } from './api/decorators/user.decorator';
export { CreateUserDto, UserRawDto } from './api/users.dto';
export { AuthService } from './application/auth.service';
export { UserUtilsService } from './application/user-utils.service';
export { SecretBox } from './infra/crypto/secret-box';
export { KeyStore } from './infra/keys/key-store.service';
export { OidcService } from './infra/oidc/oidc.service';
export type { RequestWithUser } from './api/request-with-user';
export { IdentityTopicsModule } from './realtime-topics.module';
