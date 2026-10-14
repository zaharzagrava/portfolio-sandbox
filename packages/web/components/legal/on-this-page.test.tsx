import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { OnThisPage } from './on-this-page';

const sections = [
  { id: 'one', title: 'First section' },
  { id: 'two', title: 'Second section' },
  { id: 'three', title: 'Third section' },
];

function Page() {
  return (
    <>
      <OnThisPage sections={sections} />
      {sections.map((section) => (
        <section key={section.id}>
          <h2 id={section.id} tabIndex={-1}>
            {section.title}
          </h2>
        </section>
      ))}
    </>
  );
}

afterEach(() => window.history.replaceState(null, '', '/'));

describe('W07 legal "On this page" (AS-25)', () => {
  it('W07 AS-25: one labelled navigation with a link per section, in order, pointing at the anchors', () => {
    render(<Page />);
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(sections.map((section) => section.title));
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#one', '#two', '#three']);
  });

  it('W07 AS-25: the mobile list is a disclosure that starts collapsed, and holds the same links', () => {
    const { container } = render(<Page />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(within(details as HTMLElement).getByText('On this page')).toBeInTheDocument();
    expect(within(details as HTMLElement).getAllByRole('link', { hidden: true })).toHaveLength(sections.length);
  });

  it('W07 AS-25: activating a link puts the address anchor and the focus on that heading', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    await user.click(within(nav).getByRole('link', { name: 'Second section' }));
    expect(window.location.hash).toBe('#two');
    expect(screen.getByRole('heading', { name: 'Second section' })).toHaveFocus();
  });

  it('W07 AS-25: opening the page with an anchor in the address moves focus to that heading', () => {
    window.history.replaceState(null, '', '/#three');
    render(<Page />);
    expect(screen.getByRole('heading', { name: 'Third section' })).toHaveFocus();
  });

  it('W07 AS-25: a link whose heading does not exist does not throw', async () => {
    const user = userEvent.setup();
    render(<OnThisPage sections={[{ id: 'missing', title: 'Missing' }]} />);
    await user.click(screen.getAllByRole('link', { name: 'Missing', hidden: true })[0]);
    expect(window.location.hash).toBe('#missing');
  });
});
