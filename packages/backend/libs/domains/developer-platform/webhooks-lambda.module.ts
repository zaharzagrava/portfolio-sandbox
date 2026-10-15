import { INestApplicationContext, Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { DatabaseModule } from '@app/infrastructure/database';
import { PlatformModule } from '@app/infrastructure/platform';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { WebhookLambdaHandlerHost } from './infra/webhook-lambda.handler-host';
import { WebhooksCoreModule } from './webhooks-core.module';

/**
 * The Lambda host of delivery (`apps/lambdas/src/handlers/webhook-delivery.ts`): configuration, platform services,
 * the database, Redis and the shared webhook module, each imported here so the handler boots with this module alone
 * (L-018). The app asks it for the handler host with `WebhooksLambdaModule.host(context)`.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    DatabaseModule,
    RedisModule,
    WebhooksCoreModule,
  ],
  providers: [WebhookLambdaHandlerHost],
  exports: [WebhookLambdaHandlerHost],
})
export class WebhooksLambdaModule {
  static host(context: INestApplicationContext): WebhookLambdaHandlerHost {
    return WebhookLambdaHandlerHost.resolve(context);
  }
}
