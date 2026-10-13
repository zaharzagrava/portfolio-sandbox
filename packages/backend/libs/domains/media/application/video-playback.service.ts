import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  ProductVideos,
  VideoPlayback,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ProductQueryService } from '@app/domains/catalog';
import {
  credentialExpiresAt,
  DeliveryEdge,
  DeliveryEdgeNotConfiguredError,
  type SignedCookies,
} from '@app/infrastructure/delivery-edge';
import {
  deliveryPrefix,
  deliveryUrl,
  unlistedResourcePattern,
} from '../domain/delivery-paths';
import {
  productNotFound,
  serviceUnavailable,
  videoNotFound,
} from '../domain/video-errors';
import { PRODUCT_LIST_LIMIT } from '../domain/video-limits';
import { VideoMetrics, VideoStore } from '../domain/video-ports';
import { VIDEO_ORIGIN } from '../video.constants';
import { toPlayback } from './video-view';

export interface PlaybackAnswer {
  body: VideoPlayback;
  visibility: 'public' | 'unlisted';
  /** Signed cookies and their expiry, for an unlisted video only. */
  credential: { cookies: SignedCookies; expiresAt: Date } | null;
}

/** Equal-length digests make the comparison constant-time whatever the lengths of the two inputs. */
const sameToken = (given: string, stored: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(given).digest(),
    createHash('sha256').update(stored).digest(),
  );

/**
 * Playback and the product page list (S30 R-13–R-15): anonymous, read-only, no write per view (AS-40) and no call to
 * another domain on the playback path. A hidden video, a wrong token and an unknown id are one and the same `404`.
 */
@Injectable()
export class VideoPlaybackService {
  constructor(
    private readonly store: VideoStore,
    private readonly edge: DeliveryEdge,
    private readonly products: ProductQueryService,
    private readonly metrics: VideoMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(VIDEO_ORIGIN) private readonly origin: string,
  ) {}

  async playback(id: string, token: string | null): Promise<PlaybackAnswer> {
    const found = await this.store.video.findPlayable(id);
    const video = found?.video;
    const hidden =
      !found ||
      !video ||
      video.status !== 'READY' ||
      !video.outputs ||
      found.suspended;
    if (hidden) {
      this.metrics.inc('video_playback_total', {
        visibility: 'unknown',
        result: 'not_found',
      });
      throw videoNotFound();
    }

    if (video.visibility === 'public') {
      this.metrics.inc('video_playback_total', {
        visibility: 'public',
        result: 'ok',
      });
      return {
        body: toPlayback(video, this.origin, null),
        visibility: 'public',
        credential: null,
      };
    }

    if (!token || !video.shareToken || !sameToken(token, video.shareToken)) {
      this.metrics.inc('video_playback_total', {
        visibility: 'unknown',
        result: 'not_found',
      });
      throw videoNotFound();
    }
    const expiresAt = credentialExpiresAt(this.clock);
    let cookies: SignedCookies;
    try {
      cookies = await this.edge.signCookies({
        resourcePattern: unlistedResourcePattern(this.origin, video.id),
        expiresAt,
      });
    } catch (error) {
      // Never degrade to an unsigned address: no key, no URL, no cookie.
      this.metrics.inc('video_playback_total', {
        visibility: 'unlisted',
        result: 'unavailable',
      });
      if (error instanceof DeliveryEdgeNotConfiguredError)
        throw serviceUnavailable();
      throw error;
    }
    this.metrics.inc('video_playback_total', {
      visibility: 'unlisted',
      result: 'ok',
    });
    return {
      body: toPlayback(video, this.origin, expiresAt),
      visibility: 'unlisted',
      credential: { cookies, expiresAt },
    };
  }

  /** `READY` public videos of a visible product, newest first, at most 10 (AS-38). One R1 batch read. */
  async productVideos(productId: string): Promise<ProductVideos> {
    const product = (await this.products.getProductsByIds([productId])).get(
      productId.toLowerCase(),
    );
    if (!product || product.status !== 'ACTIVE' || product.isSandbox)
      throw productNotFound();
    if (await this.store.video.shopSuspended(product.shopId))
      throw productNotFound();
    const videos = await this.store.video.listPublicByProduct(
      product.id,
      PRODUCT_LIST_LIMIT,
    );
    return {
      items: videos
        .filter((v) => v.outputs)
        .map((v) => ({
          videoId: v.id,
          title: v.title,
          posterUrl: deliveryUrl(
            this.origin,
            `${deliveryPrefix(v.visibility, v.id)}${v.outputs!.poster}`,
          ),
          durationSec: v.durationSec ?? 0,
        })),
    };
  }
}
