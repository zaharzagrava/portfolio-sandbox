import { Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ClickHouseService } from './clickhouse.service';

@Module({
  imports: [ApiConfigModule],
  providers: [ClickHouseService],
  exports: [ClickHouseService],
})
export class ClickHouseModule { }
