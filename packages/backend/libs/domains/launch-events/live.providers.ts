import type { Provider } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { LiveCommentService } from './application/live-comment.service';
import { readLiveConfig } from './application/live-config';
import { LiveEventLog } from './application/live-event-log';
import { LiveHistoryService } from './application/live-history.service';
import { LiveLimits } from './application/live-limits';
import { LiveModerationService } from './application/live-moderation.service';
import { LiveMutes } from './application/live-mutes.service';
import { LivePinService } from './application/live-pin.service';
import { LiveReactionService } from './application/live-reaction.service';
import { LiveRemovalService } from './application/live-removal.service';
import { LiveSnapshotService } from './application/live-snapshot.service';
import { LiveStateCache } from './application/live-state-cache';
import { LiveStreamService } from './application/live-stream.service';
import {
  ACTIVE_STREAM_SET,
  CLIENT_IDS,
  COMMENT_FEED,
  COMMENT_HISTORY_READER,
  LIVE_MUTES,
  LIVE_SETTINGS,
  LIVE_STREAMS,
  LIVE_TIMERS,
  MUTE_CACHE,
  REACTION_COUNTERS,
  RECENT_COMMENT_STORE,
  REMOVAL_CLAIMS,
  TICKER_COORDINATION,
  TOXICITY_CLASSIFIER,
  VIEWER_COUNTS,
} from './domain/live-ports';
import { DynamoCommentHistoryReader } from './infra/dynamo-comment-history.reader';
import { HeuristicToxicityClassifier } from './infra/heuristic-toxicity.classifier';
import { SystemLiveTimers } from './infra/live-timers';
import { RedisActiveStreams } from './infra/redis/redis-active-streams';
import { RedisClientIds } from './infra/redis/redis-client-ids';
import { RedisCommentFeed } from './infra/redis/redis-comment-feed';
import { RedisMuteCache } from './infra/redis/redis-mute.cache';
import { RedisReactionCounters } from './infra/redis/redis-reaction.counters';
import { RedisRecentCommentStore } from './infra/redis/redis-recent-comments.store';
import { RedisRemovalClaims } from './infra/redis/redis-removal-claims';
import { RedisTickerCoordination } from './infra/redis/redis-ticker-coordination';
import { RedisViewerStore } from './infra/redis-viewer-store';
import { SequelizeLiveMuteRepository } from './infra/sequelize-live-mute.repository';
import { SequelizeLiveStreamRepository } from './infra/sequelize-live-stream.repository';

/** The adapters of the live ports (D-6): the application layer injects the tokens, never these classes. */
export const LIVE_STREAM_ADAPTERS: Provider[] = [
  { provide: LIVE_STREAMS, useClass: SequelizeLiveStreamRepository },
  { provide: LIVE_MUTES, useClass: SequelizeLiveMuteRepository },
];
export const LIVE_FAST_STORE_ADAPTERS: Provider[] = [
  { provide: RECENT_COMMENT_STORE, useClass: RedisRecentCommentStore },
  { provide: COMMENT_FEED, useClass: RedisCommentFeed },
  { provide: MUTE_CACHE, useClass: RedisMuteCache },
  { provide: REACTION_COUNTERS, useClass: RedisReactionCounters },
  { provide: VIEWER_COUNTS, useClass: RedisViewerStore },
  { provide: ACTIVE_STREAM_SET, useClass: RedisActiveStreams },
  { provide: CLIENT_IDS, useClass: RedisClientIds },
  { provide: REMOVAL_CLAIMS, useClass: RedisRemovalClaims },
  { provide: TICKER_COORDINATION, useClass: RedisTickerCoordination },
];
export const LIVE_HISTORY_ADAPTERS: Provider[] = [
  { provide: COMMENT_HISTORY_READER, useClass: DynamoCommentHistoryReader },
];
export const LIVE_SUPPORT_PROVIDERS: Provider[] = [
  { provide: TOXICITY_CLASSIFIER, useClass: HeuristicToxicityClassifier },
  {
    provide: LIVE_SETTINGS,
    inject: [ApiConfigService],
    // Validated at start (a value outside its bounds fails the config schema, naming the setting); unset takes the default.
    useFactory: readLiveConfig,
  },
  { provide: LIVE_TIMERS, useClass: SystemLiveTimers },
];

/** The application services the core module needs (HTTP). */
export const LIVE_SERVICES: Provider[] = [
  LiveLimits,
  LiveStateCache,
  LiveEventLog,
  LiveMutes,
  LiveModerationService,
  LiveRemovalService,
  LiveStreamService,
  LivePinService,
  LiveCommentService,
  LiveReactionService,
  LiveSnapshotService,
  LiveHistoryService,
];
