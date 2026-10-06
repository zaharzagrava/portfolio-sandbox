import { chunkSections, estimateTokens, markdownSections, pdfSections } from './chunker';
import { reciprocalRankFusion } from './rrf';

const para = (words: number, word = 'lorem') => Array.from({ length: words }, () => word).join(' ');

describe('markdownSections', () => {
  it('tracks the heading path and ignores # lines inside code fences', () => {
    const md = ['Intro text.', '# Battery', 'Lasts all day.', '## Charging', 'Fast charging 45 W.', '```bash', '# not a heading', '```', '# Display', 'OLED.'].join('\n');
    expect(markdownSections(md, 'Pixel 10 manual')).toEqual([
      { headings: ['Pixel 10 manual'], page: null, text: 'Intro text.' },
      { headings: ['Pixel 10 manual', 'Battery'], page: null, text: 'Lasts all day.' },
      { headings: ['Pixel 10 manual', 'Battery', 'Charging'], page: null, text: 'Fast charging 45 W.\n```bash\n# not a heading\n```' },
      { headings: ['Pixel 10 manual', 'Display'], page: null, text: 'OLED.' },
    ]);
  });
});

describe('pdfSections', () => {
  it('detects numbered and ALL-CAPS headings and never spans pages', () => {
    const pages = ['SAFETY\nKeep away from water.\n1 Getting started\nPress the power button.\n1.1 Charging\nUse the cable.', 'More about charging.\n1.2 eSIM support\nDual SIM.'];
    expect(pdfSections(pages, 'Manual')).toEqual([
      { headings: ['Manual', 'SAFETY'], page: 1, text: 'Keep away from water.' },
      { headings: ['Manual', '1 Getting started'], page: 1, text: 'Press the power button.' },
      { headings: ['Manual', '1 Getting started', '1.1 Charging'], page: 1, text: 'Use the cable.' },
      { headings: ['Manual', '1 Getting started', '1.1 Charging'], page: 2, text: 'More about charging.' },
      { headings: ['Manual', '1 Getting started', '1.2 eSIM support'], page: 2, text: 'Dual SIM.' },
    ]);
  });
});

describe('chunkSections', () => {
  it('keeps chunks within the size bound and overlaps consecutive chunks of a section', () => {
    const text = Array.from({ length: 12 }, (_, i) => para(300, `w${i % 10}`)).join('\n\n'); // 12 paragraphs × ~225 tokens
    const chunks = chunkSections([{ headings: ['Doc', 'Long'], page: null, text }], { maxTokens: 800, overlapTokens: 250 });

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
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} ${para(20)}.`).join(' ');
    const giant = 'x'.repeat(10_000);
    const chunks = chunkSections([{ headings: ['D'], page: null, text: `${sentences}\n\n${giant}` }], { maxTokens: 300, overlapTokens: 0 });
    for (const c of chunks) expect(estimateTokens(c.content)).toBeLessThanOrEqual(300);
    expect(chunks.map((c) => c.content).join('')).toContain('Sentence number 39');
  });

  it('merges tiny sibling FAQ sections, keeping their headings inline, but not across parents', () => {
    const sections = [
      { headings: ['FAQ', 'Shipping', 'Do you ship to Norway?'], page: null, text: 'Yes, 3-5 days.' },
      { headings: ['FAQ', 'Shipping', 'Is shipping free?'], page: null, text: 'Above €50.' },
      { headings: ['FAQ', 'Returns', 'How long?'], page: null, text: '30 days.' },
    ];
    const chunks = chunkSections(sections);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ headingPath: 'FAQ > Shipping', content: 'Do you ship to Norway?\nYes, 3-5 days.\n\nIs shipping free?\nAbove €50.' });
    expect(chunks[1]).toMatchObject({ headingPath: 'FAQ > Returns > How long?', content: '30 days.' });
  });
});

describe('reciprocalRankFusion', () => {
  it('rewards documents ranked well by both retrievers over a single-list #1', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['b', 'd', 'a'],
    ]);
    expect(fused.map((f) => f.id)).toEqual(['b', 'a', 'd', 'c']);
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61);
  });

  it('is stable for ties and tolerates empty lists', () => {
    expect(reciprocalRankFusion([['x'], [], ['y']]).map((f) => f.id)).toEqual(['x', 'y']);
    expect(reciprocalRankFusion([])).toEqual([]);
  });
});
