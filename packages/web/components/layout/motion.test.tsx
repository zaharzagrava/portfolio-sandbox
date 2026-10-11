// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');

/** The body of the first `@media (prefers-reduced-motion: reduce) { ... }` block (brace-balanced). */
function reducedMotionBlock(source: string): string {
  const start = source.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
  if (start < 0) return '';
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(source.indexOf('{', start) + 1, i);
  }
  return '';
}

describe('W07 reduced motion (AS-33)', () => {
  const block = reducedMotionBlock(css);

  it('W07 AS-33: a prefers-reduced-motion block exists', () => {
    expect(block).not.toBe('');
  });

  it.each(['[data-slot="sheet-content"]', '[data-slot="sheet-overlay"]', '[data-sonner-toast]'])(
    'W07 AS-33: %s has no animation and no transition under reduced motion',
    (selector) => {
      const rule = block.split('}').find((part) => part.includes(selector));
      expect(rule, `no rule for ${selector}`).toBeDefined();
      expect(rule).toMatch(/animation:\s*none\s*!important/);
      expect(rule).toMatch(/transition:\s*none\s*!important/);
    },
  );

  it('W07 AS-33: the theme control icons only animate when motion is allowed', () => {
    const source = readFileSync(path.resolve(__dirname, 'theme-control.tsx'), 'utf8');
    expect(source).toContain('motion-safe:transition-transform');
    expect(source).not.toMatch(/(?<!motion-safe:)transition-all/);
  });
});
