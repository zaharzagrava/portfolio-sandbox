import { Global, Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { AutocompleteService } from './application/autocomplete.service';
import { SearchQueryLogger } from './infra/search-query-logger';
import { AutocompleteController } from './api/autocomplete.controller';

/** SD-12 serving side (core). Global: the product search endpoint logs queries through it. */
@Global()
@Module({
  imports: [AuthModule, ElasticsearchModule, KafkaProducerModule, StorageModule],
  providers: [AutocompleteService, SearchQueryLogger],
  exports: [AutocompleteService, SearchQueryLogger],
  controllers: [AutocompleteController],
})
export class AutocompleteModule {}
