import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ProblemCatalogModule } from '@app/common/errors';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { CacheModule } from '@app/infrastructure/cache';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { ChatAuthority } from './application/chat-authority';
import { ChatChannelService } from './application/chat-channel.service';
import { ChatPublisher } from './application/chat-publisher';
import { CHAT_SETTINGS } from './domain/chat-settings.token';
import { readChatSettings } from './domain/config';
import { CHAT_PROBLEMS } from './domain/errors';
import { PORTS } from './domain/ports';
import { SequelizeChannelRepository } from './infra/channel.repository';
import { LiveBusAdapter } from './infra/live-bus.adapter';
import { SequelizeMembershipRepository } from './infra/membership.repository';
import { SequelizeMessageRepository } from './infra/message.repository';
import { ChatMessageService } from './application/chat-message.service';
import { ChatSyncService } from './application/chat-sync.service';
import { ChatPartitionService } from './application/chat-partition.service';
import { ChatReadStateService } from './application/chat-read-state.service';
import { ChatModerationService } from './application/chat-moderation.service';
import { ChatShopBackfillService } from './application/chat-shop-backfill.service';
import { ChatShopPurgeService } from './application/chat-shop-purge.service';
import { SequelizePurgeRepository } from './infra/purge.repository';
import { SequelizeShopBackfillRepository } from './infra/shop-backfill.repository';
import { ShopProvisionerAdapter } from './infra/shop-provisioner.adapter';
import { ChatTicketService } from './application/chat-ticket.service';
import { JwtWsTicketSigner } from './infra/ws-ticket.signer';
import { ApiConfigModule } from '@app/common/config';
import { ChatPresenceService } from './application/chat-presence.service';
import {
  PresenceReaderAdapter,
  RedisPresenceStore,
} from './infra/presence.store';
import { SequelizeReadStateRepository } from './infra/read-state.repository';
import { RealtimeHubAdapter } from './infra/realtime-hub.adapter';
import { RealtimeModule } from '@app/infrastructure/realtime';
import { SequelizeSyncRepository } from './infra/sync.repository';
import { RecentWindowCache } from './infra/recent-window.cache';
import { SequelizePartitionRepository } from './infra/partition.repository';
import './application/chat.job-types';
import ChatChannelMember from './infra/models/chat-channel-member.model';
import ChatChannel from './infra/models/chat-channel.model';
import ChatMessageIndex from './infra/models/chat-message-index.model';
import ChatMessage from './infra/models/chat-message.model';
import { ProductLookupAdapter } from './infra/product-lookup.adapter';
import { ShopAuthorityAdapter } from './infra/shop-authority.adapter';
import { chatRatePolicies } from './rate-limit-policies';

/**
 * Everything the HTTP modules share: the repositories and adapters bound to their ports and the application services
 * (S24 D-6). One module, so the sides never declare the same provider twice.
 */
@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    CacheModule,
    RealtimeModule,
    ProductModule,
    TenancyModule,
    ProblemCatalogModule.forFeature(CHAT_PROBLEMS),
    RateLimitModule.forFeature(chatRatePolicies),
    SequelizeModule.forFeature([
      ChatChannel,
      ChatChannelMember,
      ChatMessage,
      ChatMessageIndex,
    ]),
  ],
  providers: [
    {
      provide: CHAT_SETTINGS,
      useFactory: () =>
        readChatSettings({ get: (k: string) => process.env[k] } as never),
    },
    { provide: PORTS.ChannelRepository, useClass: SequelizeChannelRepository },
    {
      provide: PORTS.MembershipRepository,
      useClass: SequelizeMembershipRepository,
    },
    { provide: PORTS.ProductLookup, useClass: ProductLookupAdapter },
    { provide: PORTS.ShopAuthority, useClass: ShopAuthorityAdapter },
    { provide: PORTS.LiveBusPort, useClass: LiveBusAdapter },
    { provide: PORTS.MessageRepository, useClass: SequelizeMessageRepository },
    { provide: PORTS.SyncRepository, useClass: SequelizeSyncRepository },
    { provide: PORTS.RecentWindow, useClass: RecentWindowCache },
    {
      provide: PORTS.PartitionRepository,
      useClass: SequelizePartitionRepository,
    },
    {
      provide: PORTS.ReadStateRepository,
      useClass: SequelizeReadStateRepository,
    },
    { provide: PORTS.RealtimeHub, useClass: RealtimeHubAdapter },
    RedisPresenceStore,
    { provide: PORTS.PresenceStore, useExisting: RedisPresenceStore },
    { provide: PORTS.PresenceReader, useClass: PresenceReaderAdapter },
    ChatAuthority,
    ChatPublisher,
    ChatChannelService,
    ChatMessageService,
    ChatSyncService,
    ChatPartitionService,
    ChatReadStateService,
    ChatPresenceService,
    { provide: PORTS.TicketSigner, useClass: JwtWsTicketSigner },
    ChatModerationService,
    ChatTicketService,
    { provide: PORTS.PurgeRepository, useClass: SequelizePurgeRepository },
    {
      provide: PORTS.ShopBackfillRepository,
      useClass: SequelizeShopBackfillRepository,
    },
    { provide: PORTS.ShopProvisioner, useClass: ShopProvisionerAdapter },
    ChatShopPurgeService,
    ChatShopBackfillService,
  ],
  exports: [
    ChatShopPurgeService,
    ChatShopBackfillService,
    ChatModerationService,
    ChatTicketService,
    ChatReadStateService,
    ChatPresenceService,
    PORTS.PresenceReader,
    PORTS.RealtimeHub,
    PORTS.MessageRepository,
    ChatMessageService,
    ChatSyncService,
    ChatPartitionService,
    CHAT_SETTINGS,
    PORTS.ChannelRepository,
    PORTS.MembershipRepository,
    PORTS.LiveBusPort,
    ChatAuthority,
    ChatPublisher,
    ChatChannelService,
  ],
})
export class ChatCoreModule {}
