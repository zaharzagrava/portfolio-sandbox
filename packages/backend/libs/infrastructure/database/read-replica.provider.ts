import { FactoryProvider } from '@nestjs/common';
import { Sequelize } from 'sequelize';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { Environment } from '@app/common/types';

export const READ_REPLICA_CONNECTION = Symbol('READ_REPLICA_CONNECTION');
/** Per-instance cap; counts toward the pool arithmetic (primary max + replica max). */
export const READ_REPLICA_POOL_MAX = 5;

/**
 * Read-only handle for queries that tolerate replica lag (S54 G-25). Sessions are read-only
 * (`default_transaction_read_only`), the certificate is verified in production and the pool is
 * bounded. Host falls back to the primary when `DB_READ_REPLICA_HOST` is unset.
 */
export const readReplicaProvider: FactoryProvider<Sequelize> = {
  provide: READ_REPLICA_CONNECTION,
  inject: [ApiConfigService],
  useFactory: (config: ApiConfigService) =>
    new Sequelize({
      dialect: 'postgres',
      host: process.env.DB_READ_REPLICA_HOST ?? config.get('db_host'),
      port: Number(config.get('db_port')),
      username: config.get('db_username'),
      password: config.get('db_password'),
      database: config.get('db_name'),
      logging: false,
      pool: {
        max: Math.min(
          config.get('db_replica_pool_max') ?? READ_REPLICA_POOL_MAX,
          READ_REPLICA_POOL_MAX,
        ),
        min: 0,
        acquire: config.get('db_acquire_timeout_ms') ?? 3_000,
        idle: 10_000,
      },
      dialectOptions: {
        statement_timeout: config.get('db_statement_timeout_ms') ?? 30_000,
        idle_in_transaction_session_timeout:
          config.get('db_idle_in_tx_timeout_ms') ?? 30_000,
        application_name: `${config.get('app_name') ?? process.env.OTEL_SERVICE_NAME ?? 'marketplace'}-replica`,
        options: '-c default_transaction_read_only=on',
        ...(config.get('node_env') === Environment.production && {
          ssl: { require: true, rejectUnauthorized: true },
        }),
      },
    }),
};
