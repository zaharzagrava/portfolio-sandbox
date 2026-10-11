import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GlobalError from './global-error';

const GENERIC = 'We hit an unexpected problem. Try again, and if it keeps happening come back in a few minutes.';

/** The component renders a whole document; parse its markup instead of mounting `<html>` inside the test container. */
const documentOf = (error: Error & { digest?: string }) => {
  const markup = renderToStaticMarkup(<GlobalError error={error} retry={() => {}} reset={() => {}} />);
  return new DOMParser().parseFromString(`<!DOCTYPE html>${markup}`, 'text/html');
};

describe('W07 global error (AS-11)', () => {
  it('W07 AS-11: its own html lang and body', () => {
    const doc = documentOf(new Error('x'));
    expect(doc.documentElement.getAttribute('lang')).toBe('en');
    expect(doc.body).not.toBeNull();
  });

  it('W07 AS-11: one h1, the same text, Try again and Go to home', () => {
    const doc = documentOf(new Error('x'));
    expect(doc.querySelectorAll('h1')).toHaveLength(1);
    expect(doc.querySelector('h1')?.textContent).toBe('Something went wrong');
    expect(doc.body.textContent).toContain(GENERIC);
    expect(Array.from(doc.querySelectorAll('button')).map((b) => b.textContent)).toContain('Try again');
    expect(doc.querySelector('a[href="/"]')?.textContent).toBe('Go to home');
  });

  it('W07 AS-11: touch targets are at least 44 px high and the reference appears only with a digest', () => {
    const doc = documentOf(Object.assign(new Error('x'), { digest: 'abc123' }));
    for (const control of doc.querySelectorAll('button, a')) expect(control.className).toMatch(/min-h-11|h-11|min-h-\[44px\]/);
    expect(doc.body.textContent).toContain('Reference: abc123');
    expect(documentOf(new Error('x')).body.textContent).not.toContain('Reference:');
  });

  it('W07 AS-11: nothing of the thrown message is rendered', () => {
    const doc = documentOf(new Error('relation "users" does not exist'));
    expect(doc.body.textContent).not.toContain('relation');
  });

  it('W07 AS-11: independent of providers and of the root layout (no theme class needed)', () => {
    const doc = documentOf(new Error('x'));
    expect(doc.documentElement.className + doc.body.className).toMatch(/prefers-color-scheme/);
  });
});
