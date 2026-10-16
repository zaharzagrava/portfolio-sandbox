import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { AppError } from '@app/common/errors';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { ShopAccessService } from '@app/domains/tenancy';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `order-export:{exportId}` (S12 FR-019, AS-18): a signed-in user who is currently a member of the export's shop with
 * `orders.manage`. The export's shop is read by id from this domain's own table; the membership decision goes through
 * tenancy's exported R1 service, never its tables. Every refusal (no user, unknown export, not a member, no permission,
 * a member removed a moment ago) is the same `false`; any other failure propagates so the stream answers
 * `503 realtime_policy_unavailable`. No `job:` prefix is registered by this domain.
 */
@Injectable()
export class OrderExportTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    private readonly access: ShopAccessService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'order-export',
      owner: 'orders',
      policy: async (viewer, _topic, exportId) => {
        if (!viewer.userId || !UUID.test(exportId)) return false;
        const [job] = await this.sequelize.query<{ shopId: string }>(
          `SELECT "shopId" FROM "ExportJob" WHERE "id" = :exportId`,
          { type: QueryTypes.SELECT, replacements: { exportId } },
        );
        if (!job) return false;
        try {
          await this.access.assertMember(
            job.shopId,
            viewer.userId,
            'orders.manage',
          );
          return true;
        } catch (error) {
          if (error instanceof AppError && Number(error.status) < 500)
            return false;
          throw error;
        }
      },
    });
  }
}

/** The routes this domain declares in the shared topic type (S51 FR-024). */
declare module '@app/infrastructure/realtime/topics' {
  interface RealtimeTopicPrefixes {
    'order-export': `order-export:${string}`;
  }
}
