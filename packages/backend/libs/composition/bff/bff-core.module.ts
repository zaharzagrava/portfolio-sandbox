import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { BffSettings } from './bff-config';
import { CredentialsGuard } from './credentials/credentials.guard';
import { RequestCredentials } from './credentials/request-credentials';
import { SessionAccess } from './credentials/session-access';
import { bffRatePolicies } from './rate-limit-policies';
import { CurrentRequest } from './request-id';
import {
  AmbiguityGuard,
  CsrfGuard,
  OriginGuard,
  RequestGuards,
} from './session/csrf-origin.guard';
import { IdentityClient } from './session/identity-client';
import { RefreshCoordinator } from './session/refresh-coordinator';
import { SessionAccessService } from './session/session-access.service';
import { SessionManager } from './session/session-manager';
import { SessionService } from './session/session.service';
import { SessionStore } from './session/session-store';
import { BreakerRegistry } from './upstream/breaker-registry';
import { ShapedCache } from './upstream/shaped-cache';
import { UpstreamClient } from './upstream/upstream-client';

const PROVIDERS = [
  BffSettings,
  CurrentRequest,
  ShapedCache,
  BreakerRegistry,
  UpstreamClient,
  RequestCredentials,
  CredentialsGuard,
  SessionStore,
  SessionManager,
  RefreshCoordinator,
  IdentityClient,
  SessionService,
  RequestGuards,
  OriginGuard,
  CsrfGuard,
  AmbiguityGuard,
  { provide: SessionAccess, useClass: SessionAccessService },
];

/** What the REST and GraphQL slices share: settings, the upstream layer, credentials and the session machinery. */
@Module({
  imports: [
    ApiConfigModule,
    RateLimitModule,
    RateLimitModule.forFeature(bffRatePolicies),
  ],
  providers: PROVIDERS,
  exports: PROVIDERS,
})
export class BffCoreModule {}
