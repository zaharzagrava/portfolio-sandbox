import * as fc from 'fast-check';
import {
  chunkSections,
  estimateTokens,
  markdownSections,
  pdfSections,
} from './chunker';

const para = (words: number, word = 'lorem') =>
  Array.from({ length: words }, () => word).join(' ');

describe('markdownSections', () => {
  it('tracks the heading path and ignores # lines inside code fences', () => {
    const md = [
      'Intro text.',
      '# Battery',
      'Lasts all day.',
      '## Charging',
      'Fast charging 45 W.',
      '```bash',
      '# not a heading',
      '```',
      '# Display',
      'OLED.',
    ].join('\n');
    expect(markdownSections(md, 'Pixel 10 manual')).toEqual([
      { headings: ['Pixel 10 manual'], page: null, text: 'Intro text.' },
      {
        headings: ['Pixel 10 manual', 'Battery'],
        page: null,
        text: 'Lasts all day.',
      },
      {
        headings: ['Pixel 10 manual', 'Battery', 'Charging'],
        page: null,
        text: 'Fast charging 45 W.\n```bash\n# not a heading\n```',
      },
      { headings: ['Pixel 10 manual', 'Display'], page: null, text: 'OLED.' },
    ]);
  });
});

describe('pdfSections', () => {
  it('detects numbered and ALL-CAPS headings and never spans pages', () => {
    const pages = [
      'SAFETY\nKeep away from water.\n1 Getting started\nPress the power button.\n1.1 Charging\nUse the cable.',
      'More about charging.\n1.2 eSIM support\nDual SIM.',
    ];
    expect(pdfSections(pages, 'Manual')).toEqual([
      {
        headings: ['Manual', 'SAFETY'],
        page: 1,
        text: 'Keep away from water.',
      },
      {
        headings: ['Manual', '1 Getting started'],
        page: 1,
        text: 'Press the power button.',
      },
      {
        headings: ['Manual', '1 Getting started', '1.1 Charging'],
        page: 1,
        text: 'Use the cable.',
      },
      {
        headings: ['Manual', '1 Getting started', '1.1 Charging'],
        page: 2,
        text: 'More about charging.',
      },
      {
        headings: ['Manual', '1 Getting started', '1.2 eSIM support'],
        page: 2,
        text: 'Dual SIM.',
      },
    ]);
  });
});

describe('chunkSections', () => {
  it('keeps chunks within the size bound and overlaps consecutive chunks of a section', () => {
    const text = Array.from({ length: 12 }, (_, i) =>
      para(300, `w${i % 10}`),
    ).join('\n\n'); // 12 paragraphs × ~225 tokens
    const chunks = chunkSections(
      [{ headings: ['Doc', 'Long'], page: null, text }],
      { maxTokens: 800, overlapTokens: 250 },
    );

    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(800);
    for (let i = 1; i < chunks.length; i++) {
      const lastOfPrev = chunks[i - 1].content.split('\n\n').at(-1)!;
      expect(chunks[i].content.startsWith(lastOfPrev)).toBe(true);
    }
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.headingPath === 'Doc > Long')).toBe(true);
  });

  it('splits an oversized paragraph by sentences, then by characters', () => {
    const sentences = Array.from(
      { length: 40 },
      (_, i) => `Sentence number ${i} ${para(20)}.`,
    ).join(' ');
    const giant = 'x'.repeat(10_000);
    const chunks = chunkSections(
      [{ headings: ['D'], page: null, text: `${sentences}\n\n${giant}` }],
      { maxTokens: 300, overlapTokens: 0 },
    );
    for (const c of chunks)
      expect(estimateTokens(c.content)).toBeLessThanOrEqual(300);
    expect(chunks.map((c) => c.content).join('')).toContain(
      'Sentence number 39',
    );
  });

  it('merges tiny sibling FAQ sections, keeping their headings inline, but not across parents', () => {
    const sections = [
      {
        headings: ['FAQ', 'Shipping', 'Do you ship to Norway?'],
        page: null,
        text: 'Yes, 3-5 days.',
      },
      {
        headings: ['FAQ', 'Shipping', 'Is shipping free?'],
        page: null,
        text: 'Above €50.',
      },
      {
        headings: ['FAQ', 'Returns', 'How long?'],
        page: null,
        text: '30 days.',
      },
    ];
    const chunks = chunkSections(sections);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      headingPath: 'FAQ > Shipping',
      content:
        'Do you ship to Norway?\nYes, 3-5 days.\n\nIs shipping free?\nAbove €50.',
    });
    expect(chunks[1]).toMatchObject({
      headingPath: 'FAQ > Returns > How long?',
      content: '30 days.',
    });
  });
});

const tokensOf = (text: string) => estimateTokens(text);
const sentenceOf = (i: number) => `Fact number ${i} about the product is true.`;

describe('S47 AS-34: structure-aware chunking (pure rules)', () => {
  const options = { minTokens: 300, maxTokens: 800, overlapTokens: 80 };

  describe.each([
    [
      'nested headings',
      markdownSections(
        '# A\nalpha text\n## B\nbeta text\n### C\ngamma text',
        'Doc',
      ),
      ['Doc > A', 'Doc > A > B', 'Doc > A > B > C'],
    ],
    [
      'a fenced code block with # lines',
      markdownSections(
        '# Real\ntext\n```\n# not a heading\n## nor this\n```\nmore text',
        'Doc',
      ),
      ['Doc > Real'],
    ],
    [
      'numbered and all-capitals PDF headings over pages',
      pdfSections(
        [
          '1 Intro\nWelcome text.',
          '1.1 Setup\nPlug it in.\nCHARGING\nUse the cable.',
        ],
        'Manual',
      ),
      ['Manual > 1 Intro', 'Manual > 1 Intro > 1.1 Setup', 'Manual > CHARGING'],
    ],
  ])('%s', (_name, sections, headingPaths) => {
    it('S47 AS-34: heading path is the document title plus the enclosing headings; no # line inside a fence is a heading', () => {
      const chunks = chunkSections(sections);
      expect(chunks.map((c) => c.headingPath)).toEqual(headingPaths);
      expect(
        chunks.every((c) => c.headingPath.startsWith(sections[0].headings[0])),
      ).toBe(true);
    });
  });

  it('S47 AS-34: a PDF section never spans pages', () => {
    const chunks = chunkSections(
      pdfSections(
        ['1 Intro\nPage one text.', 'Still the intro on page two.'],
        'Manual',
      ),
    );
    expect(chunks.map((c) => c.page)).toEqual([1, 2]);
    expect(chunks[0].content).not.toContain('page two');
  });

  it('S47 AS-34: a section too big for one chunk splits into chunks of about 300–800 tokens, never above 800, overlapping by about 80', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) =>
      Array.from({ length: 12 }, (_, j) => sentenceOf(i * 12 + j)).join(' '),
    );
    const chunks = chunkSections(
      [
        {
          headings: ['Doc', 'Long'],
          page: null,
          text: paragraphs.join('\n\n'),
        },
      ],
      options,
    );

    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(800);
    for (const c of chunks.slice(0, -1))
      expect(c.tokens).toBeGreaterThanOrEqual(300);
    for (let i = 1; i < chunks.length; i++) {
      // The longest start of this chunk that the previous chunk ends with.
      const previous = chunks[i - 1].content;
      const current = chunks[i].content;
      let shared = 0;
      for (
        let length = Math.min(previous.length, current.length);
        length > 0;
        length--
      )
        if (previous.endsWith(current.slice(0, length))) {
          shared = length;
          break;
        }
      expect(tokensOf(current.slice(0, shared))).toBeGreaterThanOrEqual(20); // about 80 tokens, never none
      expect(tokensOf(current.slice(0, shared))).toBeLessThanOrEqual(80);
    }
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('S47 AS-34: a paragraph or sentence close to the limit never makes a chunk above 800 tokens (overlap included)', () => {
    const nearLimit = (words: number) =>
      `${Array.from({ length: words }, () => 'wordy').join(' ')}.`;
    for (const words of [100, 400, 520, 540, 600]) {
      const text = Array.from({ length: 6 }, () => nearLimit(words)).join(
        '\n\n',
      );
      const chunks = chunkSections(
        [{ headings: ['D'], page: null, text }],
        options,
      );
      for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(800);
    }
  });

  it('S47 AS-34: an oversize paragraph splits by sentences, a giant sentence by characters, and all text survives', () => {
    const giant = 'x'.repeat(9_000);
    const chunks = chunkSections(
      [
        {
          headings: ['D'],
          page: null,
          text: `${sentenceOf(1)} ${sentenceOf(2)}\n\n${giant}`,
        },
      ],
      { ...options, maxTokens: 300, overlapTokens: 0 },
    );
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(300);
    expect(chunks.map((c) => c.content).join('')).toContain(sentenceOf(2));
    expect(
      chunks
        .map((c) => c.content.replace(/\n/g, ''))
        .join('')
        .split('x').length - 1,
    ).toBe(9_000);
  });

  it('S47 AS-34: tiny sibling sections merge under their parent but never across parents', () => {
    const chunks = chunkSections([
      { headings: ['FAQ', 'Shipping', 'Q1'], page: null, text: 'A1' },
      { headings: ['FAQ', 'Shipping', 'Q2'], page: null, text: 'A2' },
      { headings: ['FAQ', 'Returns', 'Q3'], page: null, text: 'A3' },
    ]);
    expect(chunks.map((c) => c.headingPath)).toEqual([
      'FAQ > Shipping',
      'FAQ > Returns > Q3',
    ]);
  });

  it('S47 AS-34: ordinals run 0…n-1 without gaps and the same input always yields the same chunks', () => {
    const text = Array.from({ length: 30 }, (_, i) =>
      sentenceOf(i).repeat(15),
    ).join('\n\n');
    const sections = [{ headings: ['D', 'S'], page: null, text }];
    const first = chunkSections(sections, options);
    const second = chunkSections(structuredClone(sections), options);
    expect(second).toEqual(first);
    expect(first.map((c) => c.ordinal)).toEqual(first.map((_, i) => i));
  });

  it('S47 AS-34: every sentence of the input appears in at least one chunk (property)', () => {
    const word = fc.stringMatching(/^[a-z]{1,12}$/);
    const sentence = fc
      .array(word, { minLength: 1, maxLength: 40 })
      .map((words) => `${words.join(' ')}.`);
    const paragraph = fc
      .array(sentence, { minLength: 1, maxLength: 60 })
      .map((s) => s.join(' '));
    fc.assert(
      fc.property(
        fc.array(paragraph, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 100, max: 800 }),
        fc.integer({ min: 0, max: 120 }),
        (paragraphs, maxTokens, overlapTokens) => {
          const chunks = chunkSections(
            [
              {
                headings: ['D', 'S'],
                page: null,
                text: paragraphs.join('\n\n'),
              },
            ],
            { minTokens: 100, maxTokens, overlapTokens },
          );
          const all = chunks.map((c) => c.content).join('\n');
          for (const p of paragraphs)
            for (const s of p.split(/(?<=[.!?])\s+/))
              if (tokensOf(s) <= maxTokens) expect(all).toContain(s);
          for (const c of chunks)
            expect(c.tokens).toBeLessThanOrEqual(maxTokens);
        },
      ),
      { numRuns: 150 },
    );
  });
});
