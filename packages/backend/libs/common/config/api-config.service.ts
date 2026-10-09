import { Injectable, Logger } from '@nestjs/common';
import * as joi from 'joi';
import { Config, EnvConfig, SecretsManagerConfig } from './types';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { ConfigUtilsService } from './config-utils/config-utils.service';
import { Environment, Environments } from '@app/common/types';
import { isSecretKey } from '@app/common/logging/redaction';
import { ConfigRules } from './config-rules';
import { eventsConfigKeys } from './events-config';
import { jobsConfigKeys } from './jobs-config';

dotenv.config({
  /**
   * This path is relative to the backend/ project root (process.cwd()), since
   * yarn scripts / jest / the webpack-bundled Nest app are always invoked with
   * backend/ as the working directory.
   *    - in test / local we get .env from backend folder
   *    - in other environments we dont use .env file, instead we use env variables
   *      provided by Elastic Beanstalk + we combine them with secrets provided
   *      from AWS Secrets Manager. Our gitlab deployment machine has a role that
   *      allows it to read from AWS Secrets Manager, so no aws api keys should
   *      be provided for it
   *
   * Note: this used to be resolved relative to __dirname, which broke once the
   * monorepo migration caused this file to be bundled by webpack - webpack's
   * `node: { __dirname: false }` setting makes __dirname resolve to the
   * bundle's output directory (e.g. dist/apps/worker), not the original
   * source file's nested directory, so a relative `../..` traversal no longer
   * reliably lands on the project root.
   */
  path: path.resolve(
    process.cwd(),
    (() => {
      switch (process.env.NODE_ENV) {
        case Environment.test:
          return '.env.test';
        case Environment.local:
          return '.env';
        default:
          return '.env';
      }
    })(),
  ),
});

@Injectable()
export class ApiConfigService {
  protected config: Config;

  constructor(private readonly configUtilsService: ConfigUtilsService) {}

  public async init() {
    const localConfigValues: EnvConfig =
      this.configUtilsService.parseSrc<EnvConfig>(
        {
          node_env: {
            name: 'NODE_ENV',
            verify: joi
              .string()
              .valid(...Environments)
              .required(),
          },
          aws_secret_id: {
            name: 'AWS_SECRET_ID',
            verify: joi.string().optional().allow(''),
          },
          aws_region: {
            name: 'AWS_REGION',
            verify: joi.string().optional().allow(''),
          },
        },
        [process.env],
      );

    const secretsManagerConfig: SecretsManagerConfig | undefined =
      await this.configUtilsService.initSecretsManager(localConfigValues);

    const secretsMangerConfigValues: SecretsManagerConfig =
      this.configUtilsService.parseSrc<SecretsManagerConfig>(
        {
          port: {
            verify: joi.number().positive().required(),
            name: 'PORT',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },

          management_port: {
            verify: joi.number().positive().optional(),
            name: 'MANAGEMENT_PORT',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },

          shutdown_drain_delay_ms: {
            verify: joi.number().integer().positive().optional(),
            name: 'SHUTDOWN_DRAIN_DELAY_MS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          shutdown_request_drain_ms: {
            verify: joi.number().integer().positive().optional(),
            name: 'SHUTDOWN_REQUEST_DRAIN_MS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          shutdown_hard_timeout_ms: {
            verify: joi.number().integer().positive().optional(),
            name: 'SHUTDOWN_HARD_TIMEOUT_MS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          server_keep_alive_ms: {
            verify: joi.number().integer().positive().optional(),
            name: 'SERVER_KEEP_ALIVE_MS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          server_headers_timeout_ms: {
            verify: joi.number().integer().positive().optional(),
            name: 'SERVER_HEADERS_TIMEOUT_MS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          server_request_timeout_ms: {
            verify: joi.number().integer().positive().optional(),
            name: 'SERVER_REQUEST_TIMEOUT_MS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },

          db_port: {
            verify: joi.number().positive().required(),
            name: 'DB_PORT',
          },
          db_password: {
            verify: joi.string().required(),
            name: 'DB_PASSWORD',
          },
          db_username: {
            verify: joi.string().required(),
            name: 'DB_USERNAME',
          },
          db_name: {
            verify: joi.string().required(),
            name: 'DB_NAME',
          },
          db_host: {
            verify: joi.string().required(),
            name: 'DB_HOST',
          },

          throttle_api_limit: {
            verify: joi.number().required(),
            name: 'THROTTLE_API_LIMIT',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          throttle_api_ttl: {
            verify: joi.number().required(),
            name: 'THROTTLE_API_TTL',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },

          sentry_dsn: {
            verify: joi.string().required(),
            name: 'SENTRY_DSN',
          },
          app_version: {
            verify: joi.string().required(),
            name: 'APP_VERSION',
          },

          aws_access_key_id: {
            verify: joi.string().optional(),
            name: 'AWS_ACCESS_KEY_ID',
          },
          aws_secret_access_key: {
            verify: joi.string().optional(),
            name: 'AWS_SECRET_ACCESS_KEY',
          },
          // Object storage only (local MinIO); falls back to the AWS keys when unset.
          // Refresh-token reuse inside this window is a benign race, not theft (default 10 s).
          auth_refresh_reuse_grace_ms: {
            verify: joi.number().optional(),
            name: 'AUTH_REFRESH_REUSE_GRACE_MS',
          },
          s3_access_key_id: {
            verify: joi.string().optional(),
            name: 'S3_ACCESS_KEY_ID',
          },
          s3_secret_access_key: {
            verify: joi.string().optional(),
            name: 'S3_SECRET_ACCESS_KEY',
          },

          jwt_secret: {
            verify: joi.string().required(),
            name: 'JWT_SECRET',
          },
          // RS256 key pair for access tokens. Optional: when unset, AuthService
          // falls back to creds/jwtRS256.key(.pub) (see scripts/auth/generate-keys.js).
          jwt_private_key: {
            verify: joi.string().optional().allow(''),
            name: 'JWT_PRIVATE_KEY',
            postProcess: (v: any) => v?.replace(/\\n/g, '\n'),
          },
          jwt_public_key: {
            verify: joi.string().optional().allow(''),
            name: 'JWT_PUBLIC_KEY',
            postProcess: (v: any) => v?.replace(/\\n/g, '\n'),
          },
          jwt_expires_in: {
            verify: joi.string().optional().allow(''),
            name: 'JWT_EXPIRES_IN',
          },

          front_host: {
            verify: joi.string().required(),
            name: 'FRONT_HOST',
          },
          backend_host: {
            verify: joi.string().required(),
            name: 'BACKEND_HOST',
          },

          firebase_client_email: {
            verify: joi.string().required(),
            name: 'FIREBASE_CLIENT_EMAIL',
          },
          firebase_private_key: {
            verify: joi.string().required(),
            name: 'FIREBASE_PRIVATE_KEY',
            postProcess: (v: any) => v?.replace(/\\n/g, '\n'),
          },
          firebase_project_id: {
            verify: joi.string().required(),
            name: 'FIREBASE_PROJECT_ID',
          },
          firebase_web_api_key: {
            verify: joi.string().required(),
            name: 'FIREBASE_WEB_API_KEY',
          },

          kafka_broker: {
            verify: joi.string().required(),
            name: 'KAFKA_BROKER',
          },
          redis_url: {
            verify: joi.string().required(),
            name: 'REDIS_URL',
          },
          chat_ws_url: {
            verify: joi.string().required(),
            name: 'CHAT_WS_URL',
          },
          kafka_api_key: {
            verify: joi.string().required(),
            name: 'KAFKA_API_KEY',
          },
          kafka_api_secret: {
            verify: joi.string().required(),
            name: 'KAFKA_API_SECRET',
          },

          elasticsearch_node: {
            verify: joi.string().uri().required(),
            name: 'ELASTICSEARCH_NODE',
          },

          clickhouse_url: {
            verify: joi.string().uri().required(),
            name: 'CLICKHOUSE_URL',
          },
          clickhouse_user: {
            verify: joi.string().required(),
            name: 'CLICKHOUSE_USER',
          },
          clickhouse_password: {
            verify: joi.string().allow('').required(),
            name: 'CLICKHOUSE_PASSWORD',
          },
          clickhouse_database: {
            verify: joi.string().required(),
            name: 'CLICKHOUSE_DATABASE',
          },

          stripe_secret_key: {
            verify: joi.string().required(),
            name: 'STRIPE_SECRET_KEY',
          },

          is_load_test: {
            verify: joi.boolean().optional(),
            name: 'IS_LOAD_TEST',
          },

          // Showcase program (docs/showcase) - optional, defaults applied where used
          load_shedding_lag_ms: {
            verify: joi.number().optional().empty(''),
            name: 'LOAD_SHEDDING_LAG_MS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          load_shedding_max_inflight: {
            verify: joi.number().integer().min(1).optional().empty(''),
            name: 'LOAD_SHEDDING_MAX_INFLIGHT',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          log_level: {
            verify: joi
              .string()
              .valid('trace', 'debug', 'info', 'warn', 'error')
              .optional()
              .empty(''),
            name: 'LOG_LEVEL',
          },
          platform_currency: {
            verify: joi.string().optional().allow(''),
            name: 'PLATFORM_CURRENCY',
          },
          usercontent_origin: {
            verify: joi.string().optional().allow(''),
            name: 'USERCONTENT_ORIGIN',
          },
          trusted_proxies: {
            verify: joi.string().optional().allow(''),
            name: 'TRUSTED_PROXIES',
          },
          problem_type_base_url: {
            verify: joi.string().optional().allow(''),
            name: 'PROBLEM_TYPE_BASE_URL',
          },
          app_name: {
            verify: joi.string().optional().allow(''),
            name: 'APP',
          },
          db_pool_max: {
            verify: joi.number().integer().min(0).optional().empty(''),
            name: 'DB_POOL_MAX',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          db_replica_pool_max: {
            verify: joi.number().integer().min(0).optional().empty(''),
            name: 'DB_REPLICA_POOL_MAX',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          db_max_instances: {
            verify: joi.number().integer().min(0).optional().empty(''),
            name: 'DB_MAX_INSTANCES',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          db_connection_limit: {
            verify: joi.number().integer().min(0).optional().empty(''),
            name: 'DB_CONNECTION_LIMIT',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          db_reserved_connections: {
            verify: joi.number().integer().min(0).optional().empty(''),
            name: 'DB_RESERVED_CONNECTIONS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          db_statement_timeout_ms: {
            verify: joi.number().integer().min(0).optional().empty(''),
            name: 'DB_STATEMENT_TIMEOUT_MS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          db_idle_in_tx_timeout_ms: {
            verify: joi.number().integer().min(0).optional().empty(''),
            name: 'DB_IDLE_IN_TX_TIMEOUT_MS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          db_acquire_timeout_ms: {
            verify: joi.number().integer().min(0).optional().empty(''),
            name: 'DB_ACQUIRE_TIMEOUT_MS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          cors_allowed_origins: {
            verify: joi.string().optional().allow(''),
            name: 'CORS_ALLOWED_ORIGINS',
          },
          s3_endpoint: {
            verify: joi.string().optional().allow(''),
            name: 'S3_ENDPOINT',
          },
          media_bucket: {
            verify: joi.string().optional().allow(''),
            name: 'MEDIA_BUCKET',
          },
          sqs_endpoint: {
            verify: joi.string().optional().allow(''),
            name: 'SQS_ENDPOINT',
          },
          sqs_queue_url_prefix: {
            verify: joi.string().optional().allow(''),
            name: 'SQS_QUEUE_URL_PREFIX',
          },
          dynamo_endpoint: {
            verify: joi.string().optional().allow(''),
            name: 'DYNAMO_ENDPOINT',
          },
          dynamo_table_prefix: {
            verify: joi.string().optional().allow(''),
            name: 'DYNAMO_TABLE_PREFIX',
          },
          cassandra_contact_points: {
            verify: joi.string().optional().allow(''),
            name: 'CASSANDRA_CONTACT_POINTS',
          },
          cassandra_local_dc: {
            verify: joi.string().optional().allow(''),
            name: 'CASSANDRA_LOCAL_DC',
          },
          cassandra_keyspace: {
            verify: joi.string().optional().allow(''),
            name: 'CASSANDRA_KEYSPACE',
          },
          cassandra_username: {
            verify: joi.string().optional().allow(''),
            name: 'CASSANDRA_USERNAME',
          },
          auth_kek: {
            verify: joi.string().optional().allow(''),
            name: 'AUTH_KEK',
          },
          access_token_ttl_sec: {
            verify: joi.number().optional().empty(''),
            name: 'ACCESS_TOKEN_TTL_SEC',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          refresh_token_ttl_days: {
            verify: joi.number().optional().empty(''),
            name: 'REFRESH_TOKEN_TTL_DAYS',
            postProcess: (v: string) => (v ? Number(v) : undefined),
          },
          google_oidc_client_id: {
            verify: joi.string().optional().allow(''),
            name: 'GOOGLE_OIDC_CLIENT_ID',
          },
          google_oidc_client_secret: {
            verify: joi.string().optional().allow(''),
            name: 'GOOGLE_OIDC_CLIENT_SECRET',
          },
          auth_redirect_base_url: {
            verify: joi.string().optional().allow(''),
            name: 'AUTH_REDIRECT_BASE_URL',
          },
          stripe_webhook_secret: {
            verify: joi.string().optional().allow(''),
            name: 'STRIPE_WEBHOOK_SECRET',
          },
          cart_cookie_secret: {
            verify: joi.string().optional().allow(''),
            name: 'CART_COOKIE_SECRET',
          },
          db_read_host: {
            verify: joi.string().optional().allow(''),
            name: 'DB_READ_HOST',
          },
          share_link_secret: {
            verify: joi.string().optional().allow(''),
            name: 'SHARE_LINK_SECRET',
          },
          share_link_base_url: {
            verify: joi.string().optional().allow(''),
            name: 'SHARE_LINK_BASE_URL',
          },
          notification_secret: {
            verify: joi.string().optional().allow(''),
            name: 'NOTIFICATION_SECRET',
          },
          ses_from_address: {
            verify: joi.string().optional().allow(''),
            name: 'SES_FROM_ADDRESS',
          },
          smtp_url: {
            verify: joi.string().optional().allow(''),
            name: 'SMTP_URL',
          },
          twilio_account_sid: {
            verify: joi.string().optional().allow(''),
            name: 'TWILIO_ACCOUNT_SID',
          },
          twilio_auth_token: {
            verify: joi.string().optional().allow(''),
            name: 'TWILIO_AUTH_TOKEN',
          },
          twilio_from: {
            verify: joi.string().optional().allow(''),
            name: 'TWILIO_FROM',
          },
          ses_events_topic_arn: {
            verify: joi.string().optional().allow(''),
            name: 'SES_EVENTS_TOPIC_ARN',
          },
          collab_public_url: {
            verify: joi.string().optional().allow(''),
            name: 'COLLAB_PUBLIC_URL',
          },
          collab_instance_id: {
            verify: joi.string().optional().allow(''),
            name: 'COLLAB_INSTANCE_ID',
          },
          api_key_pepper: {
            verify: joi.string().optional().allow(''),
            name: 'API_KEY_PEPPER',
          },
          webhooks_allow_private_hosts: {
            verify: joi.string().optional().allow(''),
            name: 'WEBHOOKS_ALLOW_PRIVATE_HOSTS',
          },
          core_internal_url: {
            verify: joi.string().optional().allow(''),
            name: 'CORE_INTERNAL_URL',
          },
          cloudflare_zone_id: {
            verify: joi.string().optional().allow(''),
            name: 'CLOUDFLARE_ZONE_ID',
          },
          cloudflare_api_token: {
            verify: joi.string().optional().allow(''),
            name: 'CLOUDFLARE_API_TOKEN',
          },
          revalidate_secret: {
            verify: joi.string().optional().allow(''),
            name: 'REVALIDATE_SECRET',
          },
          media_cdn_url: {
            verify: joi.string().optional().allow(''),
            name: 'MEDIA_CDN_URL',
          },
          clamav_host: {
            verify: joi.string().optional().allow(''),
            name: 'CLAMAV_HOST',
          },
          ...eventsConfigKeys,
          ...jobsConfigKeys,
          cassandra_password: {
            verify: joi.string().optional().allow(''),
            name: 'CASSANDRA_PASSWORD',
          },
        },
        (() => {
          const srcList: Record<string, any>[] = [];

          if (
            [Environment.local, Environment.test].includes(
              //
              localConfigValues.node_env,
            )
            //
          ) {
            srcList.push(process.env);
          }

          if (secretsManagerConfig) {
            srcList.push(secretsManagerConfig);
          }

          return srcList;
        })(),
      );

    this.config = {
      ...localConfigValues,
      ...secretsMangerConfigValues,
    };

    // Cross-field and capability rules: every violation in one error, naming keys and never values (S54 FR-077).
    ConfigRules.assertValid(this.config as unknown as Record<string, unknown>, {
      production: this.config.node_env === Environment.production,
    });
    this.logLoadedKeys();
  }

  /** Startup line: which keys are loaded and which of them are secrets (`[set]`), never a value (S54 AS-152). */
  private logLoadedKeys(): void {
    const entries = Object.entries(
      this.config as unknown as Record<string, unknown>,
    ).filter(([, value]) => value !== undefined && value !== '');
    const secrets = entries
      .filter(([key]) => isSecretKey(key))
      .map(([key]) => `${key}=[set]`);
    const plain = entries
      .filter(([key]) => !isSecretKey(key))
      .map(([key]) => key);
    new Logger('Config').log(
      `configuration loaded: keys [${plain.join(', ')}]; secrets [${secrets.join(', ')}]`,
    );
  }

  public get<T extends keyof Config>(key: T): Config[T] {
    return this.config[key];
  }
}
