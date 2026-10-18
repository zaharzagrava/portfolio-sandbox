import { describe, expect, it } from 'vitest';
import { diffFlags } from './diff';

const base = {
  key: 'new-checkout',
  description: 'Checkout v2',
  owner: 'admin@marketplace.local',
  status: 'enabled',
  enabled: true,
  variants: [
    { key: 'off', value: false },
    { key: 'on', value: true },
  ],
  defaultVariant: 'off',
  offVariant: 'off',
  rules: [{ id: 'staff', conditions: [{ attribute: 'email_domain', op: 'in', values: ['example.com'] }], variant: 'on' }],
  bucketBy: 'userId',
  clientSide: false,
  expiresAt: null,
  version: 2,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
};

const texts = (diff: ReturnType<typeof diffFlags>) => diff.lines.map((line) => line.text);

describe('diffFlags', () => {
  it('W06 AS-41: a create entry says "Created with" and lists the whole definition as text', () => {
    const diff = diffFlags(null, { ...base, status: 'disabled', enabled: false, rules: [] });
    expect(diff.kind).toBe('created');
    expect(texts(diff)).toEqual(
      expect.arrayContaining(['Status: Disabled', 'Description: Checkout v2', 'Owner: admin@marketplace.local', 'Variants: 2 variants', 'Rules: no rules', 'Client-side: No', 'Expires: —', 'Default variant: off', 'Off variant: off', 'Bucket by: userId']),
    );
  });

  it('W06 AS-41: an update lists the fields that differ, "Status: Enabled → Killed", "Rules: 1 rule → 2 rules"', () => {
    const after = {
      ...base,
      status: 'killed',
      enabled: false,
      description: 'Checkout v3',
      rules: [...base.rules, { id: 'beta', conditions: [], variant: 'on' }],
      version: 3,
      updatedAt: '2026-10-03T10:00:00.000Z',
    };
    const diff = diffFlags(base, after);
    expect(diff.kind).toBe('changed');
    expect(texts(diff)).toEqual(['Status: Enabled → Killed', 'Description: Checkout v2 → Checkout v3', 'Rules: 1 rule → 2 rules']);
  });

  it('W06 AS-41: the full before and after of rules and variants is available as text on demand', () => {
    const diff = diffFlags(base, { ...base, rules: [{ id: 'staff', conditions: [], rollout: [{ variant: 'on', weight: 500 }, { variant: 'off', weight: 9500 }] }] });
    const line = diff.lines.find((l) => l.field === 'rules')!;
    expect(line.text).toBe('Rules: 1 rule → 1 rule (edited)');
    expect(line.detailBefore).toContain('Rule staff');
    expect(line.detailBefore).toContain('email_domain is one of example.com');
    expect(line.detailAfter).toContain('5% on, 95% off');
  });

  it.each([
    ['kill', { status: 'enabled' }, { status: 'killed', enabled: false }, 'Status: Enabled → Killed'],
    ['restore', { status: 'killed', enabled: false }, { status: 'disabled', enabled: false }, 'Status: Killed → Disabled'],
    ['archive', { status: 'disabled', enabled: false }, { status: 'archived', enabled: false }, 'Status: Disabled → Archived'],
  ])('W06 AS-41: a %s entry shows the status change', (_name, before, after, expected) => {
    expect(texts(diffFlags({ ...base, ...before }, { ...base, ...after }))).toEqual([expected]);
  });

  it('W06 AS-41: variants, client-side, expiry and bucketing read as text', () => {
    const diff = diffFlags(base, { ...base, clientSide: true, expiresAt: '2026-11-01T00:00:00Z', bucketBy: 'shopId', variants: [...base.variants, { key: 'beta', value: 'x' }] });
    expect(texts(diff)).toEqual(['Variants: 2 variants → 3 variants', 'Bucket by: userId → shopId', 'Client-side: No → Yes', 'Expires: — → 2026-11-01 00:00 UTC']);
  });

  it('W06 AS-41: no visible difference is said so', () => {
    const diff = diffFlags(base, { ...base, version: 9, updatedAt: '2027-01-01T00:00:00Z' });
    expect(diff.kind).toBe('none');
    expect(diff.lines).toEqual([]);
  });

  it('W06 AS-64: markup in a value stays a plain string', () => {
    const diff = diffFlags(base, { ...base, description: '<img src=x onerror=alert(1)>' });
    expect(diff.lines[0]!.text).toBe('Description: Checkout v2 → <img src=x onerror=alert(1)>');
  });
});
