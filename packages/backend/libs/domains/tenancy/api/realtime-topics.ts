import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { TopicRegistry } from '@app/infrastructure/realtime/topic-registry';
import ShopMembership from '../infra/models/shop-membership.model';

/** `shop:{shopId}:live` (SD-18 live sales dashboard, published by seller-insights): that shop's members only. */
@Injectable()
export class ShopTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    @InjectModel(ShopMembership)
    private readonly memberships: typeof ShopMembership,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'shop',
      suffixes: ['live'],
      policy: async (viewer, _topic, shopId) => {
        if (!viewer.userId) return false;
        return !!(await this.memberships.findOne({
          where: { shopId, userId: viewer.userId },
          attributes: ['role'],
        }));
      },
    });
  }
}
