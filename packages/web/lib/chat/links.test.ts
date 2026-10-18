import { describe, expect, it } from 'vitest';
import { chatHref, chatTargetFrom } from './links';

const UUID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const OTHER = '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f';

describe('Chat links', () => {
  it('W05 FR-003 AS-01: chatHref builds /chat, /chat?product= and /chat?channel= so no capability hand-builds the address', () => {
    expect(chatHref({})).toBe('/chat');
    expect(chatHref({ product: UUID })).toBe(`/chat?product=${UUID}`);
    expect(chatHref({ channel: UUID })).toBe(`/chat?channel=${UUID}`);
  });

  it('W05 FR-003: a value is encoded so it cannot add a parameter or break the address', () => {
    expect(chatHref({ product: 'a&channel=b' })).toBe('/chat?product=a%26channel%3Db');
    expect(chatHref({ channel: 'x y' })).toBe('/chat?channel=x%20y');
  });

  it('W05 FR-001 AS-68: chatTargetFrom reads the two parameters: a channel opens a chat, a product is the one-shot resolver, anything else is ignored', () => {
    expect(chatTargetFrom({})).toEqual({ kind: 'none' });
    expect(chatTargetFrom({ channel: UUID })).toEqual({ kind: 'channel', channelId: UUID });
    expect(chatTargetFrom({ product: UUID })).toEqual({ kind: 'product', productId: UUID });
    expect(chatTargetFrom({ other: UUID, utm_source: 'x' })).toEqual({ kind: 'none' });
    expect(chatTargetFrom(new URLSearchParams(`product=${UUID}&x=1`))).toEqual({ kind: 'product', productId: UUID });
  });

  it('W05 FR-001: a malformed channel is the unavailable state and a malformed product is the invalid-link state, both without a request', () => {
    expect(chatTargetFrom({ channel: 'nope' })).toEqual({ kind: 'invalid-channel' });
    expect(chatTargetFrom({ product: '123' })).toEqual({ kind: 'invalid-product' });
    expect(chatTargetFrom({ channel: '' })).toEqual({ kind: 'none' });
  });

  it('W05 FR-001: when both are given the open chat wins (the product is replaced by the channel once resolved); a repeated parameter uses its first value', () => {
    expect(chatTargetFrom({ channel: UUID, product: OTHER })).toEqual({ kind: 'channel', channelId: UUID });
    expect(chatTargetFrom({ channel: [UUID, OTHER] })).toEqual({ kind: 'channel', channelId: UUID });
  });
});
