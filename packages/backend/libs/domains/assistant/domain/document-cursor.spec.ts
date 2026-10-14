import { decodeDocumentCursor, encodeDocumentCursor } from './document-cursor';

const KEY = 'k'.repeat(32);
const ID = '0192f7a0-0000-7000-8000-0000000000e1';
const AT = '2026-10-13T10:00:00.123456Z';
const SCOPE = 'shop:0192f7a0-0000-7000-8000-00000000a001';

describe('S47 AS-31: document list cursor', () => {
  it('S47 AS-31: round trips the ordering key', () => {
    const cursor = encodeDocumentCursor(KEY, SCOPE, { createdAt: AT, id: ID });
    expect(decodeDocumentCursor(KEY, SCOPE, cursor)).toEqual({
      createdAt: AT,
      id: ID,
    });
  });

  it('S47 AS-31: the cursor is opaque and url safe', () => {
    const cursor = encodeDocumentCursor(KEY, SCOPE, { createdAt: AT, id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(cursor).not.toContain(ID);
  });

  it('S47 AS-31: a tampered body is refused', () => {
    const cursor = encodeDocumentCursor(KEY, SCOPE, { createdAt: AT, id: ID });
    const [body, tag] = cursor.split('.');
    const forged = Buffer.from(
      JSON.stringify({ c: AT, i: '0192f7a0-0000-7000-8000-0000000000ff' }),
    ).toString('base64url');
    expect(() => decodeDocumentCursor(KEY, SCOPE, `${forged}.${tag}`)).toThrow(
      /cursor/i,
    );
    expect(body).toBeTruthy();
  });

  it('S47 AS-31: a tampered tag, another key and another scope are refused', () => {
    const cursor = encodeDocumentCursor(KEY, SCOPE, { createdAt: AT, id: ID });
    const [body] = cursor.split('.');
    expect(() => decodeDocumentCursor(KEY, SCOPE, `${body}.AAAA`)).toThrow();
    expect(() => decodeDocumentCursor('z'.repeat(32), SCOPE, cursor)).toThrow();
    expect(() => decodeDocumentCursor(KEY, 'platform', cursor)).toThrow();
  });

  it.each([
    '',
    'abc',
    'a.b.c',
    '.',
    'not-base64.!!!',
    Buffer.from('{"c":1}').toString('base64url') + '.x',
  ])('S47 AS-31: malformed cursor %j is refused', (cursor) => {
    expect(() => decodeDocumentCursor(KEY, SCOPE, cursor)).toThrow();
  });

  it('S47 AS-31: refuses an ordering key that is not a timestamp and a uuid', () => {
    expect(() =>
      encodeDocumentCursor(KEY, SCOPE, { createdAt: 'yesterday', id: ID }),
    ).toThrow();
    expect(() =>
      encodeDocumentCursor(KEY, SCOPE, { createdAt: AT, id: 'x' }),
    ).toThrow();
  });
});
