import type {
  LivePin,
  LiveSnapshotDto,
  LiveStreamDto,
} from '@marketplace-sandbox/contracts';
import type { LiveStreamRecord, StoredPin } from '../domain/live-ports';
import type { LiveStreamState } from './live-state-cache';

type Streamish = LiveStreamRecord | LiveStreamState;
const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

export const toStreamDto = (stream: Streamish): LiveStreamDto => ({
  id: stream.id,
  shopId: stream.shopId,
  title: stream.title,
  status: stream.status,
  launchEventId: stream.launchEventId,
  startedAt: iso(stream.startedAt),
  endedAt: iso(stream.endedAt),
  createdAt: iso(stream.createdAt) as string,
});

export const toPinDto = (
  pin: StoredPin | null,
  version: number,
): LivePin | null =>
  pin
    ? {
        version,
        productId: pin.productId,
        productTitle: pin.productTitle,
        text: pin.text,
        ...(pin.stockLeft !== undefined && { stockLeft: pin.stockLeft }),
        pinnedAt: pin.pinnedAt,
      }
    : null;

export const toSnapshotBase = (
  stream: Streamish,
): Omit<LiveSnapshotDto, 'recent' | 'degraded'> => ({
  ...toStreamDto(stream),
  pin: toPinDto(stream.pin, stream.pinVersion),
  pinVersion: stream.pinVersion,
});
