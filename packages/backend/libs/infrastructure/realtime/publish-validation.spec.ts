import {
  InvalidRealtimeEventTypeError,
  InvalidRealtimePayloadError,
  InvalidRealtimeTopicError,
  RealtimePayloadTooLargeError,
} from './errors';
import { validatePublish } from './publish/publish-validation';

const LIMIT = 32 * 1024;
const circular: Record<string, unknown> = {};
circular.self = circular;

describe('S51 AS-31 publish validation', () => {
  it.each([
    ['payment.status'],
    ['delivery_offer'],
    ['assets.changed'],
    ['price'],
    ['a'],
    ['a'.repeat(64)],
    ['x-y'],
  ])('accepts the event type %s', (type) => {
    expect(() =>
      validatePublish('auction:a1', type, { ok: true }, LIMIT),
    ).not.toThrow();
  });

  it.each([
    ['empty', ''],
    ['65 characters', 'a'.repeat(65)],
    ['a space', 'bad type'],
    ['a newline', 'bad\ntype'],
    ['an upper-case letter', 'Price'],
    ['a leading digit', '1price'],
    ['reserved: open', 'open'],
    ['reserved: error', 'error'],
    ['reserved: resync', 'resync'],
    ['reserved: revoked', 'revoked'],
  ])('rejects an event type that is %s', (_label, type) => {
    expect(() => validatePublish('auction:a1', type, 1, LIMIT)).toThrow(
      InvalidRealtimeEventTypeError,
    );
  });

  it.each([
    ['accepts', 'auction:a1', true],
    ['accepts a suffixed topic', 'shop:s1:live', true],
    ['accepts a singleton', 'flags', true],
    ['accepts a hyphenated prefix', 'order-export:x', true],
    ['rejects upper case', 'USER:abc', false],
    ['rejects an empty id', 'user:', false],
    ['rejects too many segments', 'a:b:c:d', false],
    ['rejects an id of 65 characters', `a:${'x'.repeat(65)}`, false],
    ['rejects a newline', 'auction:a\n1', false],
    ['rejects the empty topic', '', false],
  ])('topic: %s (%s)', (_label, topic, valid) => {
    const run = () => validatePublish(topic, 'price', 1, LIMIT);
    if (valid) expect(run).not.toThrow();
    else expect(run).toThrow(InvalidRealtimeTopicError);
  });

  it('rejects a serialized payload over the limit and accepts one at the limit', () => {
    expect(() =>
      validatePublish('auction:a1', 'price', 'x'.repeat(LIMIT), LIMIT),
    ).toThrow(RealtimePayloadTooLargeError);
    expect(() =>
      validatePublish('auction:a1', 'price', 'x'.repeat(LIMIT - 2), LIMIT),
    ).not.toThrow();
  });

  it.each([
    ['undefined', undefined],
    ['a circular object', circular],
    ['a BigInt', { n: BigInt(1) }],
    ['a bare function', () => 1],
  ])('rejects %s as data', (_label, data) => {
    expect(() => validatePublish('auction:a1', 'price', data, LIMIT)).toThrow(
      InvalidRealtimePayloadError,
    );
  });

  it('returns the serialized payload it measured', () => {
    expect(validatePublish('auction:a1', 'price', { price: 7 }, LIMIT)).toBe(
      '{"price":7}',
    );
  });
});
