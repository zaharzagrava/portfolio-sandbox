import { syncModeration } from './moderation';

describe('syncModeration', () => {
  it.each([
    ['a link with a scheme', 'visit http://x.io', 'link'],
    ['a secure link', 'see https://x.io/a', 'link'],
    ['a www link', 'www.x.io', 'link'],
    ['plain term', 'this is a scam', 'policy'],
    ['plural and shouting with punctuation', 'SCAMS!!', 'policy'],
    ['leet spelling', 'sc4m', 'policy'],
    ['letter-spaced', 's c a m', 'policy'],
    ['stretched', 'scaaaam', 'policy'],
    ['accented', 'scám', 'policy'],
    ['two-word term', 'free iphone', 'policy'],
    ['two-word term, upper case with punctuation', 'CLICK, HERE!', 'policy'],
    ['another term', 'fake bags', 'policy'],
    ['zero-width inside the term', 'sc​am', 'policy'],
    ['symbol leet', '$cam', 'policy'],
  ])('S23 AS-19: blocks %s', (_name, text, reason) => {
    expect(syncModeration(text)).toEqual({ ok: false, reason });
  });

  it.each([
    ['letters that only look like a term', 'fa keyboard'],
    ['a word that starts with a term', 'scampi pasta'],
    ['an ordinary sentence', 'I love it'],
    ['a longer word that contains a term', 'unscamlike'],
    ['an empty-ish message', 'ok'],
    ['an emoji message', '🔥🔥🔥'],
  ])('S23 AS-19: accepts %s', (_name, text) => {
    expect(syncModeration(text)).toEqual({ ok: true });
  });

  it('S23 AS-19: a link wins over a banned term (the reason class is link)', () => {
    expect(syncModeration('scam http://x.io')).toEqual({
      ok: false,
      reason: 'link',
    });
  });
});
