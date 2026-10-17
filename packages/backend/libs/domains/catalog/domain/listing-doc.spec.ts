import * as fc from 'fast-check';
import * as Y from 'yjs';
import {
  isValidSpecEntry,
  parseSpecs,
  readListing,
  renderSpecs,
  seedListing,
} from './listing-doc';

describe('listing document reading', () => {
  it('S06 AS-31: a well typed document reads back as written', () => {
    const doc = seedListing({
      title: '  iPhone 17 ',
      description: 'Adaptive audio.',
      priceMinor: 99900,
      brand: 'Apple',
      category: 'phones',
      quantity: 12,
      specs: { Storage: '256 GB' },
    });
    expect(readListing(doc)).toEqual({
      title: 'iPhone 17',
      description: 'Adaptive audio.',
      priceMinor: 99900,
      brand: 'Apple',
      category: 'phones',
      quantity: 12,
      specs: { Storage: '256 GB' },
    });
  });

  const wrong: [string, unknown][] = [
    ['a string price', '99900'],
    ['a fractional price', 12.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a boolean', true],
    ['null', null],
  ];

  it.each(wrong)(
    'S06 AS-31: %s as priceMinor reads as undefined and never throws',
    (_label, value) => {
      const doc = new Y.Doc();
      doc.getMap('fields').set('priceMinor', value);
      expect(readListing(doc).priceMinor).toBeUndefined();
    },
  );

  it.each([
    ['brand', 5],
    ['category', { a: 1 }],
    ['quantity', 'many'],
    ['quantity', 1.5],
  ])('S06 AS-31: a wrong typed %s reads as undefined', (key, value) => {
    const doc = new Y.Doc();
    doc.getMap('fields').set(key, value);
    expect(readListing(doc)[key as 'brand']).toBeUndefined();
  });

  it('S06 AS-31: an empty document reads as empty text and undefined fields', () => {
    expect(readListing(new Y.Doc())).toEqual({
      title: '',
      description: '',
      priceMinor: undefined,
      brand: undefined,
      category: undefined,
      quantity: undefined,
      specs: {},
    });
  });

  it('S06 AS-31: spec values that are not text are left out', () => {
    const doc = new Y.Doc();
    doc.getMap('specs').set('Good', 'yes');
    doc.getMap('specs').set('Bad', 3);
    expect(readListing(doc).specs).toEqual({ Good: 'yes' });
  });
});

describe('spec table render and parse', () => {
  it('S06 AS-39: renders keys sorted under a Specifications heading', () => {
    expect(
      renderSpecs('Adaptive audio.', { Storage: '256 GB', Color: 'Black' }),
    ).toBe(
      'Adaptive audio.\n\nSpecifications\n- Color: Black\n- Storage: 256 GB',
    );
  });

  it('S06 AS-39: parses the section back and leaves the description', () => {
    expect(
      parseSpecs(
        'Adaptive audio.\n\nSpecifications\n- Color: Black\n- Storage: 256 GB',
      ),
    ).toEqual({
      description: 'Adaptive audio.',
      specs: { Color: 'Black', Storage: '256 GB' },
    });
  });

  it('S06 AS-39: an empty table renders the description unchanged', () => {
    expect(renderSpecs('Only text', {})).toBe('Only text');
    expect(parseSpecs('Only text')).toEqual({
      description: 'Only text',
      specs: {},
    });
  });

  it('S06 AS-39: a heading that is not followed by spec lines stays in the description', () => {
    const text = 'Intro\n\nSpecifications\nare listed on the box';
    expect(parseSpecs(text)).toEqual({ description: text, specs: {} });
  });

  it('S06 AS-39: re-editing never duplicates a spec line', () => {
    const once = renderSpecs('A', { K: 'v' });
    const parsed = parseSpecs(once);
    expect(renderSpecs(parsed.description, parsed.specs)).toBe(once);
  });

  const text = fc
    .string({ maxLength: 40 })
    .filter((s) => !s.includes('Specifications'));
  const entry = fc
    .tuple(fc.string({ maxLength: 12 }), fc.string({ maxLength: 20 }))
    .filter(([k, v]) => isValidSpecEntry(k, v));
  const table = fc
    .array(entry, { maxLength: 6 })
    .map((pairs) => Object.fromEntries(pairs));

  it('S06 AS-39: parse(render(d, s)) = (d, s) and render(parse(x)) = x for any input without the heading', () => {
    fc.assert(
      fc.property(text, table, (description, specs) => {
        const rendered = renderSpecs(description, specs);
        expect(parseSpecs(rendered)).toEqual({ description, specs });
        const again = parseSpecs(rendered);
        expect(renderSpecs(again.description, again.specs)).toBe(rendered);
      }),
      { numRuns: 300 },
    );
  });
});
