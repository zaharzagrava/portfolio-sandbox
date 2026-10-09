import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigService, ApiConfigModule } from '@app/common/config';

import { Environment } from '@app/common/types';
import { ClockModule } from '@app/infrastructure/platform';
import { HealthModule } from '@app/infrastructure/health';
import { PaymentModule } from '@app/domains/payments';

@Module({
  imports: [
    ApiConfigModule,
    SequelizeModule.forRootAsync({
      imports: [ApiConfigModule],
      inject: [ApiConfigService],
      useFactory: (configService: ApiConfigService) => ({
        dialect: 'postgres',
        host: configService.get('db_host'),
        port: Number(configService.get('db_port')),
        username: configService.get('db_username'),
        password: configService.get('db_password'),
        database: configService.get('db_name'),
        autoLoadModels: true,
        synchronize: false,
        logging: false,
        ...(configService.get('node_env') === Environment.production && {
          dialectOptions: {
            ssl: { require: true, rejectUnauthorized: false },
          },
        }),
      }),
    }),
    ClockModule,
    HealthModule,
    PaymentModule,
  ],
})
export class PaymentProcessorModule {}
