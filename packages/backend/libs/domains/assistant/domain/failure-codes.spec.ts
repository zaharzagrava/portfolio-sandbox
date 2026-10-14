import { KNOWLEDGE_FAILURE_CODES } from '@marketplace-sandbox/contracts';
import { FAILURE_CODES, IngestFailure, isFailureCode } from './failure-codes';

describe('S47 AS-24: failure codes', () => {
  it('S47 AS-24: the closed list equals the contract list', () => {
    expect([...FAILURE_CODES]).toEqual([...KNOWLEDGE_FAILURE_CODES]);
  });

  it.each([...KNOWLEDGE_FAILURE_CODES])('S47 AS-24: %s is a code', (code) => {
    expect(isFailureCode(code)).toBe(true);
  });

  it.each(['', 'unknown', 'NO_TEXT', 'error', undefined, null, 4])(
    'S47 AS-24: %j is not a code',
    (value) => {
      expect(isFailureCode(value)).toBe(false);
    },
  );

  it('S47 AS-24: a deterministic failure carries its code and no parser text', () => {
    const failure = new IngestFailure('unparseable', 'internal parser detail');
    expect(failure.code).toBe('unparseable');
    expect(failure.message).toBe('unparseable');
    expect(failure.detail).toBe('internal parser detail');
  });
});
