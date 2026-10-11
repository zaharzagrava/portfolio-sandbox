import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteFocus } from './route-focus';

let mockPathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

function Page({ withHeading }: { withHeading: boolean }) {
  return (
    <main id="main-content" tabIndex={-1}>
      {withHeading && <h1>New page</h1>}
      <p>content</p>
    </main>
  );
}

describe('W07 route focus (AS-07)', () => {
  beforeEach(() => {
    mockPathname = '/';
    (document.activeElement as HTMLElement | null)?.blur();
  });

  it('W07 AS-07: nothing is focused on the first load', () => {
    render(
      <>
        <RouteFocus />
        <Page withHeading />
      </>,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it('W07 AS-07: after client-side navigation focus moves to the new h1', () => {
    const { rerender } = render(
      <>
        <RouteFocus />
        <Page withHeading />
      </>,
    );
    mockPathname = '/privacy';
    rerender(
      <>
        <RouteFocus />
        <Page withHeading />
      </>,
    );
    expect(document.activeElement).toBe(document.querySelector('h1'));
  });

  it('W07 AS-07: without an h1 focus falls back to main', () => {
    const { rerender } = render(
      <>
        <RouteFocus />
        <Page withHeading={false} />
      </>,
    );
    mockPathname = '/privacy';
    rerender(
      <>
        <RouteFocus />
        <Page withHeading={false} />
      </>,
    );
    expect(document.activeElement).toBe(document.querySelector('main'));
  });

  it('W07 AS-07: a re-render with the same path (search parameter or hash change) moves nothing', () => {
    const { rerender } = render(
      <>
        <RouteFocus />
        <Page withHeading />
      </>,
    );
    rerender(
      <>
        <RouteFocus />
        <Page withHeading />
      </>,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it('W07 AS-07: it never takes focus from a control the visitor already focused in the new page', () => {
    const { rerender } = render(
      <>
        <RouteFocus />
        <main id="main-content" tabIndex={-1}>
          <h1>A</h1>
          <input aria-label="field" autoFocus />
        </main>
      </>,
    );
    const input = document.querySelector('input') as HTMLInputElement;
    input.focus();
    mockPathname = '/next';
    rerender(
      <>
        <RouteFocus />
        <main id="main-content" tabIndex={-1}>
          <h1>B</h1>
          <input aria-label="field" autoFocus />
        </main>
      </>,
    );
    expect(document.activeElement).toBe(input);
  });
});
