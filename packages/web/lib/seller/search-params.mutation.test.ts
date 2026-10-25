import { describe, expect, it } from 'vitest';
import { readCursor, readDays, readInventoryParams, readLogsParams, readOrdersParams, readUsageParams, readWebhookAttemptsParams } from './search-params';

/** Added after a mutation run (scripts/aiqa/tracks/mutation): anchors and boundaries of the URL readers that no other test guarded. */
const UUID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const EVT = `evt_${'0123456789abcdef'.repeat(2)}`;

describe('W04 search-params edges (mutation survivors)', () => {
  it('a UUID filter must be the whole value (no prefix, no suffix)', () => {
    expect(readLogsParams({ keyId: UUID }).keyId).toBe(UUID);
    expect(readLogsParams({ keyId: `x${UUID}` }).keyId).toBeUndefined();
    expect(readLogsParams({ keyId: `${UUID}x` }).keyId).toBeUndefined();
    expect(readLogsParams({ keyId: `${UUID} ` }).keyId).toBeUndefined();
  });

  it('a day filter must be exactly YYYY-MM-DD and a real calendar day', () => {
    expect(readLogsParams({ from: '2026-10-05' }).from).toBe('2026-10-05');
    expect(readLogsParams({ from: '2026-10-05x' }).from).toBeUndefined();
    expect(readLogsParams({ from: 'x2026-10-05' }).from).toBeUndefined();
    expect(readLogsParams({ to: '2026-10-05T00:00' }).to).toBeUndefined();
    expect(readLogsParams({ to: '2026-02-30' }).to).toBeUndefined();
    expect(readLogsParams({ to: '2026-04-31' }).to).toBeUndefined();
    expect(readLogsParams({ to: '2024-02-29' }).to).toBe('2024-02-29');
    expect(readLogsParams({ to: '2026-02-29' }).to).toBeUndefined();
  });

  it('days must be plain digits: no sign, no space, no exponent, no hex', () => {
    for (const bad of [' 7', '+7', '7e0', '0x7', '07 ', '9e1']) {
      expect(readDays(bad)).toBe(30);
      expect(readUsageParams({ days: bad }).days).toBe(30);
    }
    expect(readDays('07')).toBe(7);
    expect(readUsageParams({ days: '14' }).days).toBe(14);
    expect(readUsageParams({ days: '7' }).days).toBe(7);
  });

  it('inventory status keeps ACTIVE and ARCHIVED, and anything else is ACTIVE', () => {
    expect(readInventoryParams({}).status).toBe('ACTIVE');
    expect(readInventoryParams({ status: 'ACTIVE' }).status).toBe('ACTIVE');
    expect(readInventoryParams({ status: 'ARCHIVED' }).status).toBe('ARCHIVED');
    expect(readInventoryParams({ status: 'archived' }).status).toBe('ACTIVE');
    expect(readInventoryParams({ status: 'DELETED' }).status).toBe('ACTIVE');
    expect(readInventoryParams({ status: ['ARCHIVED', 'ACTIVE'] }).status).toBe('ACTIVE');
  });

  it('the cursor limit is 512 characters inclusive', () => {
    expect(readCursor('a'.repeat(512))).toBe('a'.repeat(512));
    expect(readCursor('a'.repeat(513))).toBeUndefined();
  });

  it('an orders status is one of the four known statuses, the whole value, upper case; anything else is the default', () => {
    expect(readOrdersParams({ status: 'PAID' }).status).toBe('PAID');
    expect(readOrdersParams({ status: 'REFUNDED' }).status).toBe('REFUNDED');
    expect(readOrdersParams({ status: 'PARTIALLY_SHIPPED' }).status).toBeUndefined();
    expect(readOrdersParams({ status: 'BOGUS' }).status).toBeUndefined();
    expect(readOrdersParams({ status: 'PAID-x' }).status).toBeUndefined();
    expect(readOrdersParams({ status: 'x-PAID' }).status).toBeUndefined();
    expect(readOrdersParams({ status: 'paid' }).status).toBeUndefined();
    expect(readOrdersParams({ status: '' }).status).toBeUndefined();
  });

  it('a webhook event id is evt_ plus 32 hex characters, the whole value, or a UUID', () => {
    expect(readWebhookAttemptsParams({ event: EVT }).event).toBe(EVT);
    expect(readWebhookAttemptsParams({ event: UUID }).event).toBe(UUID);
    expect(readWebhookAttemptsParams({ event: `${EVT}0` }).event).toBeUndefined();
    expect(readWebhookAttemptsParams({ event: `x${EVT}` }).event).toBeUndefined();
    expect(readWebhookAttemptsParams({ event: `${UUID}0` }).event).toBeUndefined();
  });
});
