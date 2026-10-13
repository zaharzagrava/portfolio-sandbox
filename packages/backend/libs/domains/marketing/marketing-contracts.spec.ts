import {
  createShortLinkRequestSchema,
  shortLinkSchema,
  sponsoredSlotsResponseSchema,
} from '@marketplace-sandbox/contracts';
import type { StoredLink as StoredShortLink } from './domain/ports';

const ok = (
  s: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown,
) => s.safeParse(v).success;

// Typed with the real stored link: shared fields keep their names; ownerId must never reach the wire.
const stored: StoredShortLink = {
  code: 'aB3dE9x',
  destination: 'https://shop.example/p/iphone-17?color=blue',
  ownerId: 'user-1',
  kind: 'generated',
  status: 'ACTIVE',
  createdAt: '2026-10-10T12:00:00.000Z',
  updatedAt: '2026-10-10T12:00:00.000Z',
  expiresAt: null,
};
const link = {
  code: stored.code,
  shortUrl: `https://mkt.to/${stored.code}`,
  destination: stored.destination,
  status: 'ACTIVE',
  kind: 'generated',
  createdAt: stored.createdAt,
  updatedAt: stored.createdAt,
  expiresAt: null,
};

describe('W02 B-7: share link contracts', () => {
  it('W02 B-7: the create request needs a destination and rejects unknown keys', () => {
    expect(
      ok(createShortLinkRequestSchema, { destination: stored.destination }),
    ).toBe(true);
    expect(
      ok(createShortLinkRequestSchema, {
        destination: stored.destination,
        alias: 'summer-drop',
      }),
    ).toBe(true);
    expect(ok(createShortLinkRequestSchema, {})).toBe(false);
    expect(ok(createShortLinkRequestSchema, { destination: '' })).toBe(false);
    expect(
      ok(createShortLinkRequestSchema, { destination: 'x'.repeat(2049) }),
    ).toBe(false);
    expect(
      ok(createShortLinkRequestSchema, {
        destination: stored.destination,
        ownerId: 'u',
      }),
    ).toBe(false);
  });

  it('W02 B-7: a short link parses and exposes no owner or internal field', () => {
    expect(ok(shortLinkSchema, link)).toBe(true);
    expect(
      ok(shortLinkSchema, {
        ...link,
        status: 'DISABLED',
        disabledAt: link.createdAt,
      }),
    ).toBe(true);
    expect(ok(shortLinkSchema, { ...link, ownerId: stored.ownerId })).toBe(
      false,
    );
    expect(ok(shortLinkSchema, { ...link, shortUrl: 'not a url' })).toBe(false);
    expect(ok(shortLinkSchema, { ...link, status: 'EXPIRED' })).toBe(false);
    expect(ok(shortLinkSchema, { ...link, expiresAt: undefined })).toBe(false);
  });
});

describe('W02 B-7: sponsored slot contracts', () => {
  const slot = {
    campaignId: 'c1',
    productId: 'p1',
    shopId: 's1',
    title: 'AirPods',
    priceMinor: 12900,
    currency: 'EUR',
    sponsored: true,
    clickUrl: '/ads/click/tok',
    expiresAt: '2026-10-10T12:30:00.000Z',
  };

  it('W02 B-7: a sponsored response parses up to three slots', () => {
    const body = {
      items: [slot, { ...slot, shopId: 's2' }],
      generatedAt: slot.expiresAt,
    };
    expect(ok(sponsoredSlotsResponseSchema, body)).toBe(true);
    expect(
      ok(sponsoredSlotsResponseSchema, {
        items: [],
        generatedAt: slot.expiresAt,
      }),
    ).toBe(true);
  });

  it('W02 B-7: a sponsored response rejects more than three slots, an unmarked slot and a bare array', () => {
    expect(
      ok(sponsoredSlotsResponseSchema, {
        items: [slot, slot, slot, slot],
        generatedAt: 'x',
      }),
    ).toBe(false);
    expect(
      ok(sponsoredSlotsResponseSchema, {
        items: [{ ...slot, sponsored: false }],
        generatedAt: 'x',
      }),
    ).toBe(false);
    expect(
      ok(sponsoredSlotsResponseSchema, {
        items: [{ ...slot, priceMinor: 1.5 }],
        generatedAt: 'x',
      }),
    ).toBe(false);
    expect(ok(sponsoredSlotsResponseSchema, [slot])).toBe(false);
  });
});
