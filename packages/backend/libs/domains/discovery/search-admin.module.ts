import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ShopProductSearchService } from './application/shop-product-search.service';
import { SearchQualityService } from './application/search-quality.service';
import { SearchAdminController } from './api/search-admin.controller';

/** SD-37 (core). */
@Module({
  imports: [
    AuthModule,
    ElasticsearchModule,
    ClickHouseModule,
    KafkaProducerModule,
  ],
  providers: [ShopProductSearchService, SearchQualityService],
  controllers: [SearchAdminController],
})
export class SearchAdminModule {}
