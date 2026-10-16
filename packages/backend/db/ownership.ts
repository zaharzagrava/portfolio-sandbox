/**
 * Database ownership registry (constitution IX.3). Every table in the shared `public` schema has
 * exactly one owner. Business tables belong to a domain (`libs/domains/<domain>`); the closed
 * technical allowlist belongs to an infrastructure lib. Code in a domain may only query tables it
 * owns (IX.4); everything else goes through IX.7 (exported services, BFF composition, read models).
 *
 * Enforced by `db/ownership.spec.ts` against the migrations and every model's `tableName`.
 * Partition children (`<Table>_default`, monthly partitions) and migration staging names
 * (`<Table>_new`) belong to their parent and are not listed. Seeded from
 * docs/work/architecture/domain-map.md §2–§3.
 */

export const DOMAINS = [
  'identity',
  'tenancy',
  'seller-onboarding',
  'catalog',
  'catalog-sync',
  'media',
  'orders',
  'fulfilment',
  'payments',
  'statements',
  'billing',
  'launch-events',
  'auctions',
  'chat',
  'community',
  'content',
  'notifications',
  'discovery',
  'marketing',
  'experimentation',
  'seller-insights',
  'developer-platform',
  'shop-functions',
  'asset-library',
  'assistant',
] as const;
export type Domain = (typeof DOMAINS)[number];

/** IX.3 technical allowlist owners. Adding one requires a constitution amendment. */
export const INFRASTRUCTURE_OWNERS = [
  'outbox',
  'inbox',
  'idempotency',
  'jobs',
  'database',
] as const;
export type InfrastructureOwner = (typeof INFRASTRUCTURE_OWNERS)[number];

export type Owner =
  `domain:${Domain}` | `infrastructure:${InfrastructureOwner}`;

export const OWNERSHIP = {
  // identity
  User: 'domain:identity',
  FederatedIdentity: 'domain:identity',
  SigningKey: 'domain:identity',
  PasswordResetToken: 'domain:identity',
  SecondFactor: 'domain:identity',
  MfaRecoveryCode: 'domain:identity',
  MfaChallengeState: 'domain:identity',
  // tenancy
  Shop: 'domain:tenancy',
  ShopMembership: 'domain:tenancy',
  ShopInvite: 'domain:tenancy',
  ShopDirectory: 'domain:tenancy',
  ShopSsoConfig: 'domain:tenancy',
  ShopStatusHistory: 'domain:tenancy',
  // seller-onboarding
  ShopOnboarding: 'domain:seller-onboarding',
  ShopDocument: 'domain:seller-onboarding',
  DocumentExtraction: 'domain:seller-onboarding',
  ReviewTask: 'domain:seller-onboarding',
  // catalog
  Product: 'domain:catalog',
  ListingDraft: 'domain:catalog',
  ListingDraftVersion: 'domain:catalog',
  ProductStatusHistory: 'domain:catalog',
  ProductStockOperation: 'domain:catalog',
  ProductShopState: 'domain:catalog',
  ProductViewBatch: 'domain:catalog',
  // catalog-sync
  ImportJob: 'domain:catalog-sync',
  ImportJobHistory: 'domain:catalog-sync',
  Integration: 'domain:catalog-sync',
  ExternalLink: 'domain:catalog-sync',
  SyncCursor: 'domain:catalog-sync',
  SyncQuarantine: 'domain:catalog-sync',
  ShopSyncState: 'domain:catalog-sync',
  SyncOperation: 'domain:catalog-sync',
  SyncConflict: 'domain:catalog-sync',
  ShopChangeLog: 'domain:catalog-sync',
  ProductFieldClock: 'domain:catalog-sync',
  IntegrationHistory: 'domain:catalog-sync',
  IntegrationInstall: 'domain:catalog-sync',
  SyncRun: 'domain:catalog-sync',
  StockConflict: 'domain:catalog-sync',
  WebhookReceipt: 'domain:catalog-sync',
  CatalogReconciliationRun: 'domain:catalog-sync',
  // media
  Media: 'domain:media',
  MediaStatusHistory: 'domain:media',
  // S29: gallery links and the gallery version row belong to media (S05 neither reads nor writes them)
  ProductMedia: 'domain:media',
  ProductGallery: 'domain:media',
  Video: 'domain:media',
  VideoTask: 'domain:media',
  VideoStatusHistory: 'domain:media',
  VideoShopState: 'domain:media',
  // orders (ExportJob: decision D2, order export belongs to orders)
  BisOrder: 'domain:orders',
  BisOrderItem: 'domain:orders',
  ShopOrder: 'domain:orders',
  OrderEvent: 'domain:orders',
  StockReservation: 'domain:orders',
  FlashSale: 'domain:orders',
  FlashSaleHistory: 'domain:orders',
  ExportJob: 'domain:orders',
  ExportJobHistory: 'domain:orders',
  // fulfilment
  PickupPoint: 'domain:fulfilment',
  PickupStock: 'domain:fulfilment',
  // S19: read-model copies built from catalog and tenancy events (R3), never from their tables
  PickupProductCopy: 'domain:fulfilment',
  PickupShopCopy: 'domain:fulfilment',
  Courier: 'domain:fulfilment',
  Delivery: 'domain:fulfilment',
  DeliveryEvent: 'domain:fulfilment',
  // payments (payment + ledger share one transaction boundary: decision D4)
  Payment: 'domain:payments',
  PaymentHistory: 'domain:payments',
  PayableOrder: 'domain:payments',
  LedgerEntry: 'domain:payments',
  LedgerEntry_legacy: 'domain:payments',
  Payout: 'domain:payments',
  PayoutHistory: 'domain:payments',
  PayoutRun: 'domain:payments',
  PayoutDestination: 'domain:payments',
  PayoutDestinationHistory: 'domain:payments',
  PayoutReserve: 'domain:payments',
  PayoutReserveHistory: 'domain:payments',
  PayoutAuditDay: 'domain:payments',
  PayoutAuditFinding: 'domain:payments',
  ReconciliationRun: 'domain:payments',
  ReconciliationIssue: 'domain:payments',
  // S14 ledger and reconciliation
  LedgerJournal: 'domain:payments',
  AccountBalance: 'domain:payments',
  LedgerCheckpoint: 'domain:payments',
  LedgerBackfillCursor: 'domain:payments',
  ReconciliationIssueHistory: 'domain:payments',
  ReconciliationStaging: 'domain:payments',
  ReconciliationSeen: 'domain:payments',
  ProviderAccount: 'domain:payments',
  // statements
  CommissionRate: 'domain:statements',
  StatementSnapshot: 'domain:statements',
  StatementAdjustment: 'domain:statements',
  AccountingPeriod: 'domain:statements',
  StatementSaleFact: 'domain:statements',
  StatementPayoutFact: 'domain:statements',
  StatementLedgerFact: 'domain:statements',
  StatementLedgerCredit: 'domain:statements',
  StatementStreamWatermark: 'domain:statements',
  StatementPeriodRun: 'domain:statements',
  StatementPeriodHistory: 'domain:statements',
  StatementFinding: 'domain:statements',
  StatementVerification: 'domain:statements',
  // billing
  Plan: 'domain:billing',
  Price: 'domain:billing',
  Subscription: 'domain:billing',
  Invoice: 'domain:billing',
  InvoiceLine: 'domain:billing',
  SubscriptionTransition: 'domain:billing',
  InvoiceTransition: 'domain:billing',
  SubjectPlanState: 'domain:billing',
  UsageSettlement: 'domain:billing',
  // launch-events
  LaunchEvent: 'domain:launch-events',
  Booking: 'domain:launch-events',
  LiveStream: 'domain:launch-events',
  // auctions
  Auction: 'domain:auctions',
  AuctionHistory: 'domain:auctions',
  Bid: 'domain:auctions',
  // chat
  ChatChannel: 'domain:chat',
  ChatChannelMember: 'domain:chat',
  ChatMessage: 'domain:chat',
  ChatMessageIndex: 'domain:chat',
  // community: no Postgres tables (ScyllaDB/Redis only: decision D5)
  // content
  Story: 'domain:content',
  StoryDraft: 'domain:content',
  StoryVersion: 'domain:content',
  // notifications
  NotificationPreference: 'domain:notifications',
  NotificationSettings: 'domain:notifications',
  NotificationSuppression: 'domain:notifications',
  PushDevice: 'domain:notifications',
  // discovery: Elasticsearch/Redis/ClickHouse read models plus six small search tables (S32)
  SearchShopProduct: 'domain:discovery',
  SearchShopState: 'domain:discovery',
  SearchReindexRun: 'domain:discovery',
  SearchReindexRunHistory: 'domain:discovery',
  SearchSynonymSet: 'domain:discovery',
  SearchSynonymVersion: 'domain:discovery',
  // marketing
  AdCampaign: 'domain:marketing',
  AdBillingRun: 'domain:marketing',
  // S36 sponsored listings
  AdCampaignHistory: 'domain:marketing',
  AdProductSponsorship: 'domain:marketing',
  AdShopQuota: 'domain:marketing',
  AdProductSnapshot: 'domain:marketing',
  AdShopSnapshot: 'domain:marketing',
  AdBillingAdjustment: 'domain:marketing',
  AdReconciliationRun: 'domain:marketing',
  // experimentation
  FeatureFlag: 'domain:experimentation',
  FlagAudit: 'domain:experimentation',
  FlagRuleset: 'domain:experimentation',
  Experiment: 'domain:experimentation',
  ExperimentAudit: 'domain:experimentation',
  // seller-insights
  LeaderboardSnapshot: 'domain:seller-insights',
  CompetitorWatch: 'domain:seller-insights',
  CrawlTarget: 'domain:seller-insights',
  // developer-platform
  ApiKey: 'domain:developer-platform',
  ShopApiSettings: 'domain:developer-platform',
  ApiBulkJob: 'domain:developer-platform',
  ApiBulkChunk: 'domain:developer-platform',
  ApiUsageBucket: 'domain:developer-platform',
  WebhookEndpoint: 'domain:developer-platform',
  WebhookEndpointHistory: 'domain:developer-platform', // S43: append-only state-change history, kept 400 days
  WebhookShopCounter: 'domain:developer-platform', // S43: endpoints per shop, CHECK 0..20 (store-held limit)
  WidgetSite: 'domain:developer-platform',
  WidgetSiteChange: 'domain:developer-platform',
  // shop-functions
  ShopFunction: 'domain:shop-functions',
  ShopFunctionVersion: 'domain:shop-functions',
  ShopFunctionTestCase: 'domain:shop-functions',
  // asset-library
  Asset: 'domain:asset-library',
  AssetVersion: 'domain:asset-library',
  AssetChunk: 'domain:asset-library',
  AssetChange: 'domain:asset-library',
  AssetShareLink: 'domain:asset-library',
  AssetSyncState: 'domain:asset-library',
  DigitalProduct: 'domain:asset-library',
  // assistant
  KnowledgeDocument: 'domain:assistant',
  KnowledgeChunk: 'domain:assistant',
  // IX.3 technical allowlist
  Outbox: 'infrastructure:outbox',
  ProcessedWebhookEvent: 'infrastructure:inbox', // the inbox (S53); table name kept (IX.2)
  IdempotencyKey: 'infrastructure:idempotency', // S54 request idempotency facility
  Job: 'infrastructure:jobs',
  JobKey: 'infrastructure:jobs',
  JobSchedule: 'infrastructure:jobs',
  Migration: 'infrastructure:database', // migration meta table
} as const satisfies Record<string, Owner>;

export type Table = keyof typeof OWNERSHIP;

/** Tables created by an old migration and dropped by a later one. */
export const RETIRED_TABLES = ['Inventory'] as const;

export const ownerOf = (table: string): Owner | undefined =>
  (OWNERSHIP as Record<string, Owner>)[table];

export const ownedBy = (owner: Owner): Table[] =>
  (Object.keys(OWNERSHIP) as Table[]).filter((t) => OWNERSHIP[t] === owner);
