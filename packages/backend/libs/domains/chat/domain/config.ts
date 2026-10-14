/**
 * Tunables of `chat` with validated defaults (S24 FR-040…FR-050). Read through any `{ get(key) }`; a bad value fails
 * start-up instead of changing behaviour silently.
 */
export interface ChatSettings {
  /** One offline push per (recipient, channel) per window. */
  coalescingWindowS: number;
  /** Delay before the "still unread and offline?" check. */
  offlineCheckDelayS: number;
  /** Messages the recent-window cache holds per channel. */
  recentWindow: number;
  /** Above this many active members receipts and presence broadcasts are suppressed. */
  hugeChannelThreshold: number;
  presenceTtlS: number;
  /** Months of partitions created ahead of the current one. */
  partitionMonthsAhead: number;
  /** Channels a presence broadcast reaches. */
  presenceBroadcastChannels: number;
  pushTimeoutMs: number;
}

export const CHAT_DEFAULTS: ChatSettings = {
  coalescingWindowS: 300,
  offlineCheckDelayS: 30,
  recentWindow: 50,
  hugeChannelThreshold: 50,
  presenceTtlS: 60,
  partitionMonthsAhead: 3,
  presenceBroadcastChannels: 20,
  pushTimeoutMs: 1_000,
};

type Getter = { get(key: never): unknown };

const KEYS: Record<keyof ChatSettings, string> = {
  coalescingWindowS: 'CHAT_COALESCING_WINDOW_S',
  offlineCheckDelayS: 'CHAT_OFFLINE_CHECK_DELAY_S',
  recentWindow: 'CHAT_RECENT_WINDOW',
  hugeChannelThreshold: 'CHAT_HUGE_CHANNEL_THRESHOLD',
  presenceTtlS: 'CHAT_PRESENCE_TTL_S',
  partitionMonthsAhead: 'CHAT_PARTITION_MONTHS_AHEAD',
  presenceBroadcastChannels: 'CHAT_PRESENCE_BROADCAST_CHANNELS',
  pushTimeoutMs: 'CHAT_PUSH_TIMEOUT_MS',
};

export function readChatSettings(config?: Getter): ChatSettings {
  const out = { ...CHAT_DEFAULTS };
  if (!config) return out;
  for (const field of Object.keys(KEYS) as (keyof ChatSettings)[]) {
    const raw = (config as { get(key: string): unknown }).get(KEYS[field]);
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `${KEYS[field]} must be a positive integer, got ${JSON.stringify(raw)}`,
      );
    }
    out[field] = n;
  }
  return out;
}
