import { IntersectionType } from '@nestjs/swagger';
import { Environment } from '@app/common/types';

/**
 * @description - config that should always be present in environment variables where application is run
 */
export class EnvConfig {
  node_env: Environment;

  aws_secret_id?: string;
  aws_region?: string;
}

/**
 * @description - config that is generated after fetching the secret manager API
 */
export class SecretsManagerConfig {
  port: number;
  /** Probe-only listener for apps with no HTTP surface (payment-processor); default 9091. */
  management_port?: number;
  /** Shutdown sequence and server timings (S54 FR-038 to FR-044); defaults and cross-field rules in `shutdown-config.ts`. */
  shutdown_drain_delay_ms?: number;
  shutdown_request_drain_ms?: number;
  shutdown_hard_timeout_ms?: number;
  server_keep_alive_ms?: number;
  server_headers_timeout_ms?: number;
  server_request_timeout_ms?: number;

  aws_access_key_id: string;
  aws_secret_access_key: string;

  db_port: number;
  db_password: string;
  db_username: string;
  db_name: string;
  db_host: string;

  throttle_api_limit: number;
  throttle_api_ttl: number;

  secret_salt: string;
  book_cover_s3_url: string;

  front_host: string;
  backend_host: string;

  sentry_dsn: string;
  app_version: string;

  firebase_client_email: string;
  firebase_private_key: string;
  firebase_project_id: string;
  firebase_web_api_key: string;

  resend_api_key: string;
  /** HS256 secret - only for short-lived chat WS tickets shared with the Rust gateway. */
  jwt_secret: string;
  /** RS256 access-token key pair (PEM). Optional - falls back to creds/ files. */
  jwt_private_key?: string;
  jwt_public_key?: string;
  /** Access-token lifetime, e.g. "1h" (default). */
  jwt_expires_in?: string;

  private_s3_bucket_name: string;
  quarantine_s3_bucket_name: string;

  sightengine_api_user: string;
  sightengine_api_secret: string;

  openai_api_key: string;
  elevenlabs_api_key: string;
  google_api_key: string;
  replicate_api_token: string;

  cloudfront_key_pair_id: string;
  cloudfront_private_key: string;

  stripe_secret_key: string;
  stripe_publishable_key: string;
  verification_payment_price_id: string;

  stripe_identity_session_callback_secret: string;

  kafka_broker: string;
  kafka_api_key: string;
  kafka_api_secret: string;

  redis_url: string;

  /** Public URL the browser opens the chat WebSocket against (Rust gateway). */
  chat_ws_url: string;

  elasticsearch_node: string;

  clickhouse_url: string;
  clickhouse_user: string;
  clickhouse_password: string;
  clickhouse_database: string;

  is_load_test?: boolean;

  // Showcase program (docs/showcase) - optional, defaults applied where used
  /** Event-loop p99 lag (ms) above which new requests are shed with 503. Default 200. */
  load_shedding_lag_ms?: number;
  /** Concurrent requests per instance above which default and background requests are shed (critical at twice). Default 1000. */
  load_shedding_max_inflight?: number;
  /** Log level; `info` when unset. */
  log_level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** ISO 4217 platform currency (three uppercase letters); USD outside production when unset, required in production. */
  platform_currency?: string;
  /** Origin that serves user-generated content; must differ from the app origin in production. */
  usercontent_origin?: string;
  /** `none` or a comma-separated list of proxy addresses / CIDR ranges whose X-Forwarded-For is believed. Required in production. */
  trusted_proxies?: string;
  /** Base URL of the problem document `type` member. */
  problem_type_base_url?: string;
  /** Service name, used as the database application_name. */
  app_name?: string;
  db_pool_max?: number;
  db_replica_pool_max?: number;
  db_max_instances?: number;
  db_connection_limit?: number;
  db_reserved_connections?: number;
  db_statement_timeout_ms?: number;
  db_idle_in_tx_timeout_ms?: number;
  db_acquire_timeout_ms?: number;
  /** Comma-separated CORS allowlist. Unset = reflect origin (legacy local behaviour). */
  cors_allowed_origins?: string;
  /** MinIO locally; unset in AWS (real S3). */
  s3_endpoint?: string;
  s3_access_key_id?: string;
  auth_refresh_reuse_grace_ms?: number;
  s3_secret_access_key?: string;
  media_bucket?: string;
  /** Public CDN base for derived media (CloudFront in front of the bucket), e.g. https://media.marketplace.dev (SD-10). */
  media_cdn_url?: string;
  /** clamd TCP endpoint for upload scanning, e.g. clamav:3310 (SD-27). Unset → scanning skipped (local only). */
  clamav_host?: string;
  /** ElasticMQ locally; unset in AWS. */
  sqs_endpoint?: string;
  /** e.g. http://localhost:9324/000000000000/ - queue name is appended. */
  sqs_queue_url_prefix?: string;
  /** DynamoDB Local; unset in AWS. */
  dynamo_endpoint?: string;
  dynamo_table_prefix?: string;
  /** ScyllaDB locally / Amazon Keyspaces in AWS. Comma-separated host:port. */
  cassandra_contact_points?: string;
  cassandra_local_dc?: string;
  cassandra_keyspace?: string;
  cassandra_username?: string;
  cassandra_password?: string;
  /** `poller` (default) = OutboxPublisherService; `cdc` = Debezium streams the outbox (F-05), poller disabled. */
  outbox_relay?: 'poller' | 'cdc';
  /** SD-08 Feistel key for short codes (falls back to JWT_SECRET). */
  share_link_secret?: string;
  /** SD-08 public short-link base, e.g. https://mkt.to (falls back to BACKEND_HOST/api/l). */
  share_link_base_url?: string;
  /** HMAC for unsubscribe tokens (SD-17). */
  notification_secret?: string;
  /** Verified SES sender; unset → SMTP only. */
  ses_from_address?: string;
  /** SMTP failover / local Mailpit (smtp://localhost:1025). */
  smtp_url?: string;
  twilio_account_sid?: string;
  twilio_auth_token?: string;
  twilio_from?: string;
  /** Only SNS messages from this topic are accepted on the SES webhook (anyone can sign SNS messages from THEIR topic). */
  ses_events_topic_arn?: string;
  /** This collab instance's externally reachable ws(s):// base URL (SD-16 ring routing). */
  collab_public_url?: string;
  collab_instance_id?: string;
  /** Server-side secret mixed into API key hashes (SD-07): a leaked DB dump alone can't be brute-forced offline. */
  api_key_pepper?: string;
  /** Comma list of hosts webhooks may reach over http / private IPs - local & test only, ignored in production (SD-30). */
  webhooks_allow_private_hosts?: string;
  /** Where the BFF reaches the core API (internal ALB / service discovery), e.g. http://core.internal:8000 (SD-04). */
  core_internal_url?: string;
  /** CDN purge-by-tag (SD-05); unset → purges are logged only. */
  cloudflare_zone_id?: string;
  cloudflare_api_token?: string;
  /** HMAC for the Next.js on-demand revalidation webhook (SD-05). */
  revalidate_secret?: string;
  /** Read replica for heavy reads (statements, exports). Unset = primary. */
  db_read_host?: string;
  /** SD-19 Stripe webhook signing secret (whsec_...). */
  stripe_webhook_secret?: string;
  /** SD-19 HMAC secret for guest cart cookies (falls back to JWT_SECRET). */
  cart_cookie_secret?: string;
  /** base64 32-byte key-encryption key for signing keys / MFA secrets (Secrets Manager in AWS). */
  auth_kek?: string;
  /** SD-39 access token lifetime, default 600. */
  access_token_ttl_sec?: number;
  /** default 30 */
  refresh_token_ttl_days?: number;
  google_oidc_client_id?: string;
  google_oidc_client_secret?: string;
  /** Public base URL of this API for OIDC redirect URIs, e.g. https://api.mkt.dev */
  auth_redirect_base_url?: string;
  /** SD-42. Unset → scripted LLM provider (local dev / e2e). */
  anthropic_api_key?: string;
  /** default claude-opus-5-5 */
  assistant_model?: string;
  /** Used when the main model is overloaded before the first token. default claude-sonnet-5-5 */
  assistant_fallback_model?: string;
  /** Conversation compaction. default claude-haiku-4-5 */
  assistant_summary_model?: string;
  /** default low (chat) - the main cost/quality lever after caching. */
  assistant_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Monthly allowance when the buyer's plan sets none. default 200000 */
  assistant_buyer_tokens_per_month?: number;
  /** Abort the provider call after nobody watched the stream this long. default 10000 */
  assistant_detach_grace_ms?: number;
  /** SD-43 embeddings. Unset → deterministic hashing embedder (local dev / e2e). */
  voyage_api_key?: string;
  /** default voyage-3.5 (1024 dims) */
  voyage_model?: string;
  /** Vector hits below this cosine similarity count only when FTS also matches. default 0.3 */
  rag_min_similarity?: number;
  /** SD-44 first-pass KYC extraction model. default claude-haiku-4-5 */
  onboarding_extraction_model?: string;
  /** Re-read on validation failure. default claude-opus-5-5 */
  onboarding_escalation_model?: string;
}

export class Config extends IntersectionType(EnvConfig, SecretsManagerConfig) {}
