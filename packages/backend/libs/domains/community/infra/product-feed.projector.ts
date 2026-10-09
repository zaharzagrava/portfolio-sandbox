import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { ProductModel as Product } from '@app/domains/catalog';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { KafkaTopicGroup } from '@app/infrastructure/outbox/outbox.model';
import { FeedPublisher } from '../application/feed-publisher.service';

/** New product in a shop → `new_product` feed item for the shop's followers (once per product). */
@Injectable()
export class ProductFeedProjector implements Projector {
  readonly name = 'product-feed';
  readonly topics = [KafkaTopicGroup.PRODUCTS_EVENTS];
  readonly coalesce = true;

  constructor(
    @InjectModel(Product) private readonly productModel: typeof Product,
    private readonly redis: RedisService,
    private readonly feed: FeedPublisher,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const products = await this.productModel.findAll({
      where: {
        id: { [Op.in]: events.map((e) => e.aggregateId) },
        shopId: { [Op.ne]: null },
      },
      attributes: ['id', 'shopId', 'title', 'price'],
      raw: true,
    });
    for (const p of products) {
      // products.events also fires on updates; publish a feed item only the first time we see the product.
      if (
        (await this.redis.client.set(
          `feed:product-published:${p.id}`,
          '1',
          'EX',
          30 * 86_400,
          'NX',
        )) !== 'OK'
      )
        continue;
      await this.feed.publish(`shop:${p.shopId}`, 'new_product', p.title, {
        productId: p.id,
        price: Number(p.price),
      });
    }
  }
}
