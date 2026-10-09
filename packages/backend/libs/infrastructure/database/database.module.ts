import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Sequelize } from 'sequelize';
import {
  READ_REPLICA_CONNECTION,
  readReplicaProvider,
} from './read-replica.provider';
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
        // Fail fast: waiting longer than the acquire timeout (3 s) for a connection only queues work behind an already saturated pool.
        pool: {
          max: config.get('db_pool_max') ?? 10,
          min: 0,
          acquire: config.get('db_acquire_timeout_ms') ?? 3_000,
          idle: 10_000,
        },
        dialectOptions: {
          // Server-side guards on every connection (S54 G-25): a runaway query or an abandoned transaction cannot hold a pool slot forever.
          statement_timeout: config.get('db_statement_timeout_ms') ?? 30_000,
          idle_in_transaction_session_timeout:
            config.get('db_idle_in_tx_timeout_ms') ?? 30_000,
          application_name:
            config.get('app_name') ??
            process.env.OTEL_SERVICE_NAME ??
            'marketplace',
          ...(config.get('node_env') === Environment.production && {
            ssl: { require: true, rejectUnauthorized: false },
          }),
        },
      }),
    }),
  ],
  providers: [readReplicaProvider],
  exports: [SequelizeModule, READ_REPLICA_CONNECTION],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(READ_REPLICA_CONNECTION) private readonly replica: Sequelize,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.replica.close();
  }
}
