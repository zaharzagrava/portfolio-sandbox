import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import type { Request } from 'express';
import { ApiConfigModule, ApiConfigService } from '@app/common/config';

import { Environment } from '@app/common/types';
import { CoreClient } from './core-client';
import { ProductPageService } from './product-page.service';
import { BffController } from './bff.controller';
import { ProductResolver } from './graphql/product.resolver';
import { createLoaders } from './graphql/loaders';
import { costLimit } from './graphql/limits';
import { persistedQueriesMiddleware } from './graphql/persisted-queries';
import { PERSISTED_QUERIES } from './graphql/persisted-queries.allowlist';

@Module({
  imports: [ApiConfigModule],
  providers: [CoreClient],
  exports: [CoreClient],
})
export class BffCoreModule {}

/** SD-04 BFF (apps/bff): REST aggregates for web, GraphQL for mobile. Composition only - no business rules. */
@Module({
  imports: [
    ApiConfigModule,
    BffCoreModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [ApiConfigModule, BffCoreModule],
      inject: [ApiConfigService, CoreClient],
      useFactory: (config: ApiConfigService, core: CoreClient) => ({
        autoSchemaFile: true, // code-first, schema generated in memory
        path: '/graphql',
        useGlobalPrefix: true, // served at /api/graphql, like every other route (ALB rule, web proxy)
        introspection: config.get('node_env') !== Environment.production,
        validationRules: [costLimit(6, 2_000)],
        context: ({ req }: { req: Request }) => ({
          loaders: createLoaders(core),
          auth: req.headers.authorization,
        }),
      }),
    }),
  ],
  providers: [ProductPageService, ProductResolver],
  controllers: [BffController],
})
export class BffModule implements NestModule {
  constructor(private readonly config: ApiConfigService) {}

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(
        persistedQueriesMiddleware(
          PERSISTED_QUERIES,
          this.config.get('node_env') === Environment.production,
        ),
      )
      .forRoutes('graphql');
  }
}
