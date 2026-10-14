import { IntersectionType } from '@nestjs/swagger';
import { Environment } from '@app/common/types';
import type { BffConfig } from './bff-config';
import type { DiscussionsConfig } from './discussions-config';
import type { ShareLinksConfig } from './share-links-config';
import type { FlagsConfig } from './flags-config';
import type { KnowledgeConfig } from './knowledge-config';
import type { AdsConfig } from './ads-config';

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
 * (the BFF's `bff_*` keys are merged in below from `bff-config.ts`)
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
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

  rate_limit_store_timeout_ms?: number;
  rate_limit_breaker_failures?: number;
  rate_limit_breaker_open_ms?: number;
  rate_limit_fallback_instances?: number;
  rate_limit_lease_ttl_ms?: number;
  rate_limit_penalty_max_ms?: number;

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

  private_s3_bucket_name: string;
  quarantine_s3_bucket_name: string;

  sightengine_api_user: string;
  sightengine_api_secret: string;

  openai_api_key: string;
  elevenlabs_api_key: string;
  google_api_key: string;
  replicate_api_token: string;

  /** CloudFront key pair used to sign unlisted-video cookies (S30); required in production, unset elsewhere → 503 for unlisted. */
  cloudfront_key_pair_id: string;
  cloudfront_private_key: string;
  /** Video delivery origin, an https URL on a different site from the app and the API, e.g. https://stream.marketplace.dev (S30 AS-58). */
  video_cdn_url?: string;
  /** Parent cookie domain containing both the API host and the delivery host, e.g. .marketplace.dev (S30 FR-042). */
  video_cookie_domain?: string;
  /** CloudFront distribution that serves video; with it the worker requests edge-cache removal of deleted public videos (S30 SC-008). */
  video_cloudfront_distribution_id?: string;

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
  tenancy_regions?: string;
  /** JSON object `{"<cell>": "postgres://…"}`: the dedicated database cells (S03 FR-051). Unset = pooled only. */
  tenancy_cells?: string;
  /** Pool size per cell and instance (default 5). */
  tenancy_cell_pool_max?: number;
  /** Wait for a cell connection before the shop answers `503 cell_unavailable` (default 2000). */
  tenancy_cell_acquire_timeout_ms?: number;
  /** `max_connections` of a cell database and the part of it kept for operators (defaults 100 and 20). */
  tenancy_cell_connection_limit?: number;
  tenancy_cell_reserved_connections?: number;
  /** MinIO locally; unset in AWS (real S3). */
  s3_endpoint?: string;
  s3_access_key_id?: string;
  s3_secret_access_key?: string;
  media_bucket?: string;
  /** Public CDN base for derived media (CloudFront in front of the bucket), e.g. https://media.marketplace.dev (SD-10). */
  media_cdn_url?: string;
  /** clamd TCP endpoint for upload scanning, e.g. clamav:3310 (SD-27). Required in production; unset elsewhere → scanning skipped with a warning. */
  clamav_host?: string;
  /** Non-production switch that turns the malware scan off explicitly (S29 AS-58); refused in production. */
  media_scanner_disabled?: boolean;
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
  outbox_relay: 'poller' | 'cdc';
  /** S53 FR-064: relay, consumer framework, read-your-writes and topic settings, defaults in `events-config.ts`. */
  outbox_relay_interval_ms: number;
  outbox_relay_batch: number;
  outbox_relay_lease_ms: number;
  outbox_relay_max_attempts: number;
  outbox_retention_days: number;
  /** S49 R-09: job scheduler settings, defaults in `jobs-config.ts`. */
  jobs_claim_batch: number;
  jobs_per_shop_running_cap: number;
  jobs_retain_days: number;
  jobs_poll_idle_ms: number;

  /** S13: payments settings, defaults in `payments-config.ts`. */
  payments_create_timeout_ms: number;
  payments_refund_timeout_ms: number;
  payments_lookup_timeout_ms: number;
  payments_cancel_timeout_ms: number;
  payments_refresh_timeout_ms: number;
  payments_connect_timeout_ms: number;
  payments_breaker_window_ms: number;
  payments_breaker_min_calls: number;
  payments_breaker_failure_pct: number;
  payments_breaker_open_ms: number;
  payments_breaker_slow_ms: number;
  payments_charge_max_attempts: number;
  payments_charge_deadline_seconds: number;
  payments_charge_backoff_base_ms: number;
  payments_charge_backoff_cap_ms: number;
  payments_resolve_first_delay_ms: number;
  payments_resolve_backoff_cap_ms: number;
  payments_resolve_no_record_seconds: number;
  payments_stuck_seconds: number;
  payments_sweep_interval_seconds: number;
  payments_sweep_batch: number;
  payments_refund_backoff_base_ms: number;
  payments_refund_backoff_cap_ms: number;
  payments_refund_window_seconds: number;
  payments_refund_batch: number;
  payments_order_copy_wait_ms: number;
  payments_refresh_min_interval_ms: number;
  payments_page_default: number;
  payments_page_max: number;
  payments_cursor_secret?: string;

  /** S28: line concurrency of the delivery workers, defaults in `notifications-config.ts`. */
  notifications_tx_concurrency: number;
  notifications_marketing_concurrency: number;

  /** S14: ledger and reconciliation settings, defaults in `ledger-config.ts`. */
  ledger_fee_minor: number;
  ledger_shards: number;
  ledger_lock_timeout_ms: number;
  ledger_statement_timeout_ms: number;
  reconciliation_page_size: number;
  reconciliation_catchup_days: number;
  ledger_read_hot_timeout_ms: number;
  ledger_read_durable_timeout_ms: number;
  ledger_cursor_secret?: string;

  /** S32: search settings, defaults in `search-config.ts`. */
  search_budget_ms: number;
  embedding_budget_ms: number;
  search_refresh_interval: string;
  search_tombstone_retention_days: number;
  search_previous_index_retention_hours: number;
  search_registry_ttl_ms: number;
  search_reindex_verify_wait_ms: number;
  search_boost_weights?: string;
  search_log_secret?: string;
  search_id_signing_key?: string;

  /** S33: autocomplete settings, defaults in `autocomplete-config.ts`. */
  autocomplete_catalog_budget_ms: number;
  autocomplete_typo_budget_ms: number;
  autocomplete_k: number;
  autocomplete_depth: number;
  autocomplete_min_searchers: number;
  autocomplete_window_days: number;
  autocomplete_cap: number;
  autocomplete_poll_ms: number;
  autocomplete_retention_count: number;
  autocomplete_retention_grace_ms: number;
  autocomplete_log_query_timeout_ms: number;
  autocomplete_blocklist: string;

  /** S34: recommendations settings, defaults in `recommendations-config.ts`. */
  rec_min_co_orders: number;
  rec_min_buyers: number;
  rec_top_n: number;
  rec_window_days: number;
  rec_buckets: number;
  rec_ttl_seconds: number;
  rec_expand_seeds: number;
  rec_hop_decay: number;
  rec_store_budget_ms: number;
  rec_product_budget_ms: number;
  rec_shop_budget_ms: number;
  rec_basket_min: number;
  rec_basket_max: number;

  /** S35: trending settings, defaults in `trending-config.ts`. */
  trending_weight_view: number;
  trending_weight_cart: number;
  trending_window_seconds: number;
  trending_lateness_seconds: number;
  trending_idle_seconds: number;
  trending_heap_k: number;
  trending_all_width: number;
  trending_category_width: number;
  trending_depth: number;
  trending_category_cap: number;
  trending_memory_budget_mb: number;
  trending_retention_seconds: number;
  trending_aggregate_budget_ms: number;
  trending_product_budget_ms: number;
  trending_shop_budget_ms: number;
  trending_merge_budget_ms: number;
  trending_connect_timeout_ms: number;
  trending_shutdown_deadline_ms: number;
  trending_filter_bits: number;
  trending_tick_ms: number;
  trending_merge_backoff_base_ms: number;

  /** S10: orders settings, defaults in `orders-config.ts`. */
  orders_hold_seconds: number;
  orders_cart_max_lines: number;
  orders_cart_max_quantity: number;
  orders_cart_line_ttl_days: number;
  orders_catalog_timeout_ms: number;
  orders_stock_timeout_ms: number;
  orders_discount_timeout_ms: number;
  orders_shops_timeout_ms: number;
  orders_payment_status_timeout_ms: number;
  orders_cart_store_timeout_ms: number;
  orders_lock_timeout_ms: number;
  orders_checkout_budget_ms: number;
  orders_sweeper_batch: number;
  orders_recovery_age_seconds: number;
  orders_webhook_max_attempts: number;
  orders_clear_cart_max_attempts: number;
  orders_inbox_retention_days: number;
  orders_webhook_body_limit_bytes: number;
  /** S11: flash-sale settings, defaults in `orders-config.ts`. */
  orders_flash_load_lead_seconds: number;
  orders_flash_min_lead_seconds: number;
  orders_flash_max_window_seconds: number;
  orders_flash_claim_window_seconds: number;
  orders_flash_order_margin_seconds: number;
  orders_flash_verify_interval_seconds: number;
  orders_flash_sweep_interval_seconds: number;
  orders_flash_call_timeout_ms: number;
  orders_flash_public_cache_ms: number;
  orders_flash_reconcile_wait_alert_seconds: number;
  orders_flash_key_ttl_jitter: number;
  /** S21: auction settings, defaults in `auctions-config.ts`. */
  auctions_snipe_window_ms: number;
  auctions_snipe_extension_ms: number;
  auctions_snipe_cap_ms: number;
  auctions_sweep_interval_s: number;
  auctions_hold_deadline_s: number;
  auctions_min_lead_s: number;
  auctions_min_duration_s: number;
  auctions_max_duration_s: number;
  auctions_winner_window_h: number;
  auctions_offer_window_h: number;
  auctions_view_cache_ms: number;
  auctions_order_max_attempts: number;
  auctions_max_amount_minor: number;
  auctions_partition_months_ahead: number;
  auctions_alias_secret?: string;
  consumer_batch: number;
  consumer_max_attempts: number;
  consumer_backoff_min_ms: number;
  consumer_backoff_max_ms: number;
  consumer_handler_timeout_ms: number;
  consumer_in_flight: number;
  consumer_graceful_stop_ms: number;
  consumer_session_timeout_ms: number;
  ryw_wait_budget_ms: number;
  ryw_checkpoint_ttl_s: number;
  projection_promotion_max_lag: number;
  topic_default_partitions: number;
  topic_hot_partitions: number;
  /** HMAC for unsubscribe tokens (SD-17). */
  notification_secret?: string;
  /** Verified SES sender; unset → SMTP only. */
  ses_from_address?: string;
  /** SMTP failover / local Mailpit (smtp://localhost:1025). */
  smtp_url?: string;
  /** `memory` keeps sent e-mail in process (dev/test, read through the dev mailbox); unset → SES/SMTP. */
  email_provider?: string;
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
  /** S10: the webhook secret being rotated out; accepted next to `stripe_webhook_secret`. */
  stripe_webhook_secret_previous?: string;
  /** base64 32-byte key-encryption key for signing keys / MFA secrets (Secrets Manager in AWS). */
  auth_kek?: string;
  /** base64 32-byte key-encryption key being rotated out: values sealed with it still open next to `auth_kek`. */
  auth_kek_previous?: string;
  service_token_audiences?: string;
  service_audience?: string;
  /** SD-39 access token lifetime, default 600. */
  access_token_ttl_sec?: number;
  /** default 30 */
  refresh_token_ttl_days?: number;
  google_oidc_client_id?: string;
  google_oidc_client_secret?: string;
  /** Issuer of the Google sign-in provider; default https://accounts.google.com (a private mirror or a test double). */
  google_oidc_issuer?: string;
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
  /** S47: embeddings (`voyage_*`) and `rag_*` / `knowledge_*` settings live in `knowledge-config.ts`. */
  /** SD-44 first-pass KYC extraction model. default claude-haiku-4-5 */
  onboarding_extraction_model?: string;
  /** Re-read on validation failure. default claude-opus-5-5 */
  onboarding_escalation_model?: string;
}

/** S48: BFF settings; keys, defaults and cross-checks in `bff-config.ts`. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface SecretsManagerConfig
  extends
    BffConfig,
    DiscussionsConfig,
    ShareLinksConfig,
    FlagsConfig,
    KnowledgeConfig,
    AdsConfig {}

export class Config extends IntersectionType(EnvConfig, SecretsManagerConfig) {}
