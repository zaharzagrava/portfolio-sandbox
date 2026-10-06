import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { ApiKeysService } from './application/api-keys.service';
import { ApiKeysController } from './api/api-keys.controller';

/** SD-07 dashboard side (core): keys, version pinning, logs, usage. */
@Module({
  imports: [AuthModule, ClickHouseModule, CacheModule],
  providers: [ApiKeysService],
  controllers: [ApiKeysController],
})
export class DevelopersModule {}
