import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import type { Request, Response } from 'express';
import { ApiConfigModule } from '@app/common/config';
import { BffCoreModule } from './bff-core.module';
import { BffSettings } from './bff-config';
import type { RequestWithCredentials } from './credentials/request-credentials';
import { formatGraphQLError } from './graphql/graphql-errors';
import { GraphqlGuardMiddleware } from './graphql/graphql-guard.middleware';
import { cacheHeadersPlugin } from './graphql/graphql-headers.plugin';
import { noIntrospectionRule } from './graphql/introspection-rule';
import { createGqlContext } from './graphql/loaders';
import { PERSISTED_QUERIES } from './graphql/persisted-queries.allowlist';
import { ProductResolver } from './graphql/product.resolver';
import { MinorUnitsScalar } from './graphql/types';
import {
  TRUSTED_DOCUMENT_ENTRIES,
  TrustedDocuments,
} from './graphql/trusted-documents';
import { ProductPageController } from './page/product-page.controller';
import { ProductPageService } from './page/product-page.service';
import { JsonBodyGuard, SessionController } from './session/session.controller';
import { UpstreamClient } from './upstream/upstream-client';

/**
 * S48 BFF (apps/bff): REST aggregate for web, GraphQL for mobile, browser session handling. Composition only - no data,
 * no business rules (X.8). Redis (session store, shaped cache) comes from the application's global `RedisModule`.
 */
@Module({
  imports: [
    ApiConfigModule,
    BffCoreModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [BffCoreModule],
      inject: [BffSettings, UpstreamClient],
      useFactory: (settings: BffSettings, upstream: UpstreamClient) => ({
        autoSchemaFile: true, // code-first, printed in memory and compared with the committed snapshot in the specs
        sortSchema: true,
        path: '/graphql',
        useGlobalPrefix: true, // served at /api/graphql, like every other route (ALB rule, web proxy)
        introspection: true, // refused by `noIntrospectionRule` when configured off, with a stable code
        csrfPrevention: false, // origin + CSRF token are enforced by `GraphqlGuardMiddleware`
        includeStacktraceInErrorResponses: false,
        status400ForVariableCoercionErrors: true,
        validationRules: settings.introspection ? [] : [noIntrospectionRule],
        formatError: formatGraphQLError,
        plugins: [cacheHeadersPlugin as never],
        context: ({ req, res }: { req: Request; res: Response }) => {
          const controller = new AbortController();
          res.once('close', () => controller.abort());
          return createGqlContext({
            upstream,
            settings,
            credentials: (req as RequestWithCredentials).credentials ?? {
              kind: 'anonymous',
            },
            req,
            signal: controller.signal,
          });
        },
      }),
    }),
  ],
  providers: [
    ProductResolver,
    MinorUnitsScalar,
    TrustedDocuments,
    { provide: TRUSTED_DOCUMENT_ENTRIES, useValue: PERSISTED_QUERIES },
    GraphqlGuardMiddleware,
    ProductPageService,
    JsonBodyGuard,
  ],
  controllers: [ProductPageController, SessionController],
})
export class BffModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(GraphqlGuardMiddleware).forRoutes('graphql');
  }
}
