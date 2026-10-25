import { expect, it } from 'vitest';
import { shopWritable } from './permissions';

it('W04 AS-86: a missing shop is not writable and says so', () => {
  expect(shopWritable(null)).toEqual({ writable: false, reason: 'This shop is not available.' });
  expect(shopWritable(undefined)).toEqual({ writable: false, reason: 'This shop is not available.' });
});
