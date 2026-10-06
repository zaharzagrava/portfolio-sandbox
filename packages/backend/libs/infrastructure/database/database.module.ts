import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { Environment } from '@app/common/types';

/**
 * The Sequelize root connection shared by new apps (projector, worker,
 * public-api, ...) so pool settings live in one place. Pool sized per
 * process: N instances × max must stay under PgBouncer/RDS Proxy limits.
 */
@Module({
  imports: [
    SequelizeModule.forRootAsync({
      imports: [ApiConfigModule],
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) => ({
        dialect: 'postgres',
        host: config.get('db_host'),
        port: Number(config.get('db_port')),
        username: config.get('db_username'),
        password: config.get('db_password'),
        database: config.get('db_name'),
        autoLoadModels: true,
        synchronize: false,
        logging: false,
        pool: { max: 10, min: 0, acquire: 10_000, idle: 10_000 },
        ...(config.get('node_env') === Environment.production && {
          dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
        }),
      }),
    }),
  ],
  exports: [SequelizeModule],
})
export class DatabaseModule {}
