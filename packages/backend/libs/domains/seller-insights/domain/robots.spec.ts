import { capCrawlDelayMs, isAllowed, parseRobots } from './robots';

const UA = 'MarketplacePriceBot/1.0 (+https://marketplace.dev/bot)';

const allowed = (text: string, path: string, ua = UA): boolean =>
  isAllowed(parseRobots(text, ua), path);

describe('S41 AS-19: robots rules', () => {
  it.each([
    ['empty file', '', '/p/1', true],
    ['whitespace only file', '\n\n  \n', '/p/1', true],
    ['full disallow', 'User-agent: *\nDisallow: /', '/p/1', false],
    [
      'empty Disallow allows everything',
      'User-agent: *\nDisallow:',
      '/p',
      true,
    ],
    [
      'empty Allow is ignored',
      'User-agent: *\nAllow:\nDisallow: /p',
      '/p/1',
      false,
    ],
    ['prefix match', 'User-agent: *\nDisallow: /priv', '/private/x', false],
    ['non matching prefix', 'User-agent: *\nDisallow: /priv', '/pub', true],
    [
      'longest match wins (allow longer)',
      'User-agent: *\nDisallow: /shop\nAllow: /shop/public',
      '/shop/public/1',
      true,
    ],
    [
      'longest match wins (disallow longer)',
      'User-agent: *\nAllow: /shop\nDisallow: /shop/private',
      '/shop/private/1',
      false,
    ],
    [
      'tie is allowed',
      'User-agent: *\nDisallow: /shop\nAllow: /shop',
      '/shop/1',
      true,
    ],
    [
      'tie is allowed regardless of order',
      'User-agent: *\nAllow: /shop\nDisallow: /shop',
      '/shop/1',
      true,
    ],
    ['wildcard star', 'User-agent: *\nDisallow: /*/cart', '/en/cart', false],
    [
      'wildcard star no match',
      'User-agent: *\nDisallow: /*/cart',
      '/en/x',
      true,
    ],
    ['dollar anchors end', 'User-agent: *\nDisallow: /*.pdf$', '/a.pdf', false],
    [
      'dollar anchor does not match longer',
      'User-agent: *\nDisallow: /*.pdf$',
      '/a.pdf?x=1',
      true,
    ],
    [
      'matched against path plus query',
      'User-agent: *\nDisallow: /*?sessionid=',
      '/p?sessionid=9',
      false,
    ],
    [
      'query literal rule',
      'User-agent: *\nDisallow: /p?x=1',
      '/p?x=1&y=2',
      false,
    ],
    ['regex chars are literal', 'User-agent: *\nDisallow: /a.b', '/axb', true],
    ['case sensitive paths', 'User-agent: *\nDisallow: /Admin', '/admin', true],
    [
      'field names are case insensitive',
      'USER-AGENT: *\nDISALLOW: /x\nallow: /x/y',
      '/x/z',
      false,
    ],
    [
      'comments are ignored',
      '# hi\nUser-agent: * # all\nDisallow: /x # no\n',
      '/x',
      false,
    ],
    [
      'comment-only rule value is empty',
      'User-agent: *\nDisallow: # nothing',
      '/x',
      true,
    ],
    ['CRLF line endings', 'User-agent: *\r\nDisallow: /x\r\n', '/x', false],
    ['leading BOM', '﻿User-agent: *\nDisallow: /x', '/x', false],
    [
      'rules before any user-agent are ignored',
      'Disallow: /x\nUser-agent: *\nDisallow: /y',
      '/x',
      true,
    ],
    [
      'our token group beats *',
      'User-agent: *\nDisallow: /\n\nUser-agent: MarketplacePriceBot\nAllow: /',
      '/p',
      true,
    ],
    [
      'our token group beats * (reverse order)',
      'User-agent: MarketplacePriceBot\nDisallow: /p\n\nUser-agent: *\nAllow: /',
      '/p',
      false,
    ],
    [
      'token is case-insensitive',
      'User-agent: MARKETPLACEPRICEBOT\nDisallow: /p',
      '/p',
      false,
    ],
    [
      'bot is not a substring match',
      'User-agent: bot\nDisallow: /',
      '/p',
      true,
    ],
    [
      'longer token is not a match',
      'User-agent: marketplacepricebot2\nDisallow: /',
      '/p',
      true,
    ],
    [
      'other agent group is ignored, no * group',
      'User-agent: googlebot\nDisallow: /',
      '/p',
      true,
    ],
    [
      'consecutive user-agent lines share a group',
      'User-agent: googlebot\nUser-agent: marketplacepricebot\nDisallow: /p',
      '/p',
      false,
    ],
    [
      'blank line between user-agent lines still shares group',
      'User-agent: googlebot\n\nUser-agent: marketplacepricebot\nDisallow: /p',
      '/p',
      false,
    ],
    [
      'a rule ends the group',
      'User-agent: googlebot\nDisallow: /a\nUser-agent: marketplacepricebot\nDisallow: /b',
      '/a',
      true,
    ],
    [
      'two groups of our token are merged',
      'User-agent: marketplacepricebot\nDisallow: /a\n\nUser-agent: marketplacepricebot\nDisallow: /b',
      '/b',
      false,
    ],
    [
      'rule without leading slash or star is ignored',
      'User-agent: *\nDisallow: x',
      '/x',
      true,
    ],
  ])('S41 AS-19: %s', (_name, text, path, expected) => {
    expect(allowed(text, path)).toBe(expected);
  });

  it.each([
    ['Crawl-delay: 2', 2],
    ['Crawl-delay: 0', 0],
    ['Crawl-delay: 1.5', 1.5],
    ['crawl-delay: 10 # slow', 10],
    ['Crawl-delay: -1', null],
    ['Crawl-delay: abc', null],
    ['Crawl-delay: ', null],
    ['Crawl-delay: Infinity', null],
    ['Crawl-delay: NaN', null],
    ['Crawl-delay: 1e3', null],
    ['Crawl-delay: 2,5', null],
    ['', null],
  ])('S41 AS-19: %j gives crawlDelaySec %p', (line, expected) => {
    expect(parseRobots(`User-agent: *\n${line}`, UA).crawlDelaySec).toBe(
      expected,
    );
  });

  it('S41 AS-19: crawl delay of our group is used, not the * group', () => {
    const text =
      'User-agent: *\nCrawl-delay: 9\n\nUser-agent: marketplacepricebot\nCrawl-delay: 3';
    expect(parseRobots(text, UA).crawlDelaySec).toBe(3);
  });

  it('S41 AS-19: only the first 500 KiB of a 600 KiB file is parsed', () => {
    const filler = `# ${'x'.repeat(1022)}\n`;
    const head = 'User-agent: *\nDisallow: /early\n';
    const body = filler.repeat(Math.ceil((500 * 1024) / filler.length));
    const tail = 'Disallow: /late\n';
    const text = head + body + tail + filler.repeat(100);
    expect(Buffer.byteLength(text)).toBeGreaterThan(600 * 1024 - 1024);
    expect(allowed(text, '/early')).toBe(false);
    expect(allowed(text, '/late')).toBe(true);
  });

  it('S41 AS-19: a rule within the first 500 KiB of a 600 KiB file applies', () => {
    const text =
      'User-agent: *\nDisallow: /early\n' + '#'.repeat(600 * 1024) + '\n';
    expect(allowed(text, '/early')).toBe(false);
  });
});

describe('S41 AS-22: crawl delay cap', () => {
  const rules = (crawlDelaySec: number | null) => ({
    allow: [],
    disallow: [],
    crawlDelaySec,
  });

  it.each([
    [null, 1000],
    [0, 1000],
    [0.5, 1000],
    [1, 1000],
    [2, 2000],
    [86400, 300000],
    [300, 300000],
    [301, 300000],
  ])('S41 AS-22: delay %p gives gap %p ms', (delay, expected) => {
    expect(capCrawlDelayMs(rules(delay))).toBe(expected);
  });

  it('S41 AS-22: a custom minimum gap is honoured', () => {
    expect(capCrawlDelayMs(rules(null), 2500)).toBe(2500);
    expect(capCrawlDelayMs(rules(5), 2500)).toBe(5000);
  });
});
