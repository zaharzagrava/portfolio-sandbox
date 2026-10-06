import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { Environment } from '@app/common/types';
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
    PaymentModule,
  ],
})
export class PaymentProcessorModule {}
