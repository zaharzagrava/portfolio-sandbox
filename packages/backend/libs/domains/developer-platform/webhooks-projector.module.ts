import { Module } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { OrderCommandModule } from '@app/domains/orders';
import {
  WEBHOOK_ORDER_SHOPS_FALLBACK,
  WebhookOrdersConsumer,
  WebhookPayoutsConsumer,
  WebhookProductsConsumer,
  WebhookShopDeletedConsumer,
} from './infra/webhook-consumers';
import { WebhooksCoreModule } from './webhooks-core.module';

/**
 * The projector side (apps/projector): the S53 consumers that turn other domains' events into deliveries and purge a
 * deleted shop. Started by `ProjectionsModule.forProjectors(WebhooksProjectorModule.projectors, [WebhooksProjectorModule])`;
 * specs list the same classes as providers and call them directly, so no consumer starts in a spec. `OrderCommandModule`
 * re-exports the orders read service the flagged fallback of cancel and refund events uses (plan, Complexity Tracking).
 */
@Module({
  imports: [WebhooksCoreModule, OrderCommandModule],
  providers: [
    {
      provide: WEBHOOK_ORDER_SHOPS_FALLBACK,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService): boolean =>
        config.get('webhooks_order_shops_fallback') === 'true',
    },
    WebhookOrdersConsumer,
    WebhookProductsConsumer,
    WebhookPayoutsConsumer,
    WebhookShopDeletedConsumer,
  ],
  exports: [
    WebhooksCoreModule,
    WebhookOrdersConsumer,
    WebhookProductsConsumer,
    WebhookPayoutsConsumer,
    WebhookShopDeletedConsumer,
  ],
})
export class WebhooksProjectorModule {
  /** Every consumer of this capability, for the projector app's list. */
  static readonly projectors = [
    WebhookOrdersConsumer,
    WebhookProductsConsumer,
    WebhookPayoutsConsumer,
    WebhookShopDeletedConsumer,
  ];
}
