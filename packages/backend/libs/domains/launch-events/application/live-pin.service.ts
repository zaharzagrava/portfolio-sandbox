import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  pinRequestSchema,
  type LivePin,
  type PinRequest,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ProductQueryService } from '@app/domains/catalog';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { fieldIssues } from '../domain/field-issues';
import {
  liveMalformedId,
  liveValidationFailed,
  productNotPinnable,
  streamNotFound,
  streamNotLive,
} from '../domain/live-errors';
import { streamTopic } from '../domain/live-keys';
import {
  LIVE_STREAMS,
  type LiveStreamRepository,
  type StoredPin,
} from '../domain/live-ports';
import { toPinDto } from './live-dto';
import { logLiveWarn } from './live-log';
import { LiveStateCache } from './live-state-cache';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const samePin = (current: StoredPin, wanted: PinRequest): boolean =>
  current.productId === wanted.productId &&
  current.text === wanted.text &&
  current.stockLeft === wanted.stockLeft;

/**
 * The pinned product of a live stream (FR-034 to FR-036): durable on the stream record, checked through catalog's
 * exported lookup with the shop filter, versioned +1 per change under a row lock (so concurrent pins get consecutive
 * versions), and broadcast after the commit. An identical re-pin and an empty unpin change and broadcast nothing.
 */
@Injectable()
export class LivePinService {
  private readonly logger = new Logger(LivePinService.name);

  constructor(
    @Inject(LIVE_STREAMS) private readonly streams: LiveStreamRepository,
    private readonly products: ProductQueryService,
    private readonly state: LiveStateCache,
    private readonly realtime: RealtimePublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async pin(shopId: string, streamId: string, body: unknown): Promise<LivePin> {
    const productId = (body as { productId?: unknown } | null)?.productId;
    if (typeof productId === 'string' && !UUID.test(productId))
      throw liveMalformedId('productId');
    const parsed = pinRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw liveValidationFailed(fieldIssues(parsed.error));
    const wanted = parsed.data;

    const stream = await this.streams.findById(streamId);
    if (!stream || stream.shopId !== shopId) throw streamNotFound();
    if (stream.status !== 'LIVE') throw streamNotLive();

    const product = (
      await this.products.getProductsByIds([wanted.productId], { shopId })
    ).get(wanted.productId);
    // Unknown, another shop's and archived products are refused the same way (FR-034).
    if (!product || product.status !== 'ACTIVE') throw productNotPinnable();

    const result = await this.streams.changePin(streamId, shopId, (current) => {
      if (current.status !== 'LIVE') throw streamNotLive();
      if (current.pin && samePin(current.pin, wanted)) return { kind: 'keep' };
      return {
        kind: 'set',
        pin: {
          productId: wanted.productId,
          productTitle: product.title,
          text: wanted.text,
          ...(wanted.stockLeft !== undefined && {
            stockLeft: wanted.stockLeft,
          }),
          pinnedAt: this.clock.now().toISOString(),
        },
      };
    });
    if (!result) throw streamNotFound();
    const dto = toPinDto(
      result.record.pin,
      result.record.pinVersion,
    ) as LivePin;
    if (result.changed) await this.announce(streamId, dto);
    return dto;
  }

  async unpin(shopId: string, streamId: string): Promise<void> {
    const stream = await this.streams.findById(streamId);
    if (!stream || stream.shopId !== shopId) throw streamNotFound();
    const result = await this.streams.changePin(streamId, shopId, (current) =>
      current.pin ? { kind: 'clear' } : { kind: 'keep' },
    );
    if (!result) throw streamNotFound();
    if (result.changed)
      await this.announce(streamId, {
        version: result.record.pinVersion,
        unpinned: true,
      });
  }

  /** Drop the cached state first, so a viewer who joins after the publish reads the new pin. */
  private async announce(
    streamId: string,
    payload: LivePin | { version: number; unpinned: true },
  ): Promise<void> {
    await this.state.evict(streamId).catch(() => undefined);
    const result = await this.realtime
      .publish(streamTopic(streamId), 'pin', payload)
      .catch(() => ({ published: false, id: null }));
    if (!result.published)
      logLiveWarn(this.logger, 'pin_not_published', { streamId });
  }
}
