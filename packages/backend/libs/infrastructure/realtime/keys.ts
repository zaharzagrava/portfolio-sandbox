/** Store keys owned by this lib (constitution I.4, prefix `rt:`). See specs/domains/S51-realtime-push/data-model.md. */
export const streamKey = (topic: string) => `rt:s:${topic}`;
export const channelName = (topic: string) => `rt:c:${topic}`;
export const CONTROL_CHANNEL = 'rt:ctl';
export const CHANNEL_PREFIX = 'rt:c:';
