import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { TopicRegistry } from '@app/infrastructure/realtime/topic-registry';

/** `delivery:{id}` (SD-23 live tracking): the buyer and the assigned courier only. */
@Injectable()
export class DeliveryTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'delivery',
      policy: async (viewer, _topic, deliveryId) => {
        if (!viewer.userId) return false;
        const rows = await this.sequelize.query(`SELECT 1 FROM "Delivery" WHERE id = :deliveryId AND (:userId IN ("buyerId", "courierId"))`, {
          type: QueryTypes.SELECT,
          replacements: { deliveryId, userId: viewer.userId },
        });
        return rows.length > 0;
      },
    });
  }
}
