import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { memo, useState, type ReactNode } from 'react';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { emptyResponse, problemResponse, suggestBody } from '@/lib/test/msw-handlers';

const nav = { pathname: '/', search: '', push: vi.fn() };
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

import { SearchBox } from '@/components/search/search-box';

const IPHONE = ['iphone 17', 'iphone charger', 'iphone 17 pro max case', 'Apple iPhone 17 Pro 256GB', 'iPhone 17 Silicone Case'];

function wrapper(children: ReactNode) {
  const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const suggestions = (texts: string[]) => server.use(http.get('*/api/suggest', ({ request }) => HttpResponse.json(suggestBody(new URL(request.url).searchParams.get('q') ?? '', texts))));

beforeEach(() => {
  nav.pathname = '/';
  nav.search = '';
  nav.push.mockClear();
  window.history.replaceState(null, '', '/');
});

describe('SearchBox', () => {
  it('W02 AS-06: the input is the combobox, named "Search products", with the list attributes', () => {
    render(wrapper(<SearchBox variant="hero" />));
    const input = screen.getByRole('combobox', { name: 'Search products' });
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('maxlength', '100');
  });

  it('W02 AS-05: typing shows the suggestions in the order given, as options of a labelled listbox', async () => {
    suggestions(IPHONE);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    const input = screen.getByRole('combobox');
    await user.type(input, 'iph');
    const listbox = await screen.findByRole('listbox', { name: 'Search suggestions' });
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual(IPHONE);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', listbox.id);
    expect(await screen.findByRole('status')).toHaveTextContent('5 suggestions available');
  });

  it('W02 AS-06: Down and Up move through the options and wrap; focus stays in the input', async () => {
    suggestions(IPHONE);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    const input = screen.getByRole('combobox');
    await user.type(input, 'iph');
    await screen.findByRole('listbox');
    const options = screen.getAllByRole('option');
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}');
    expect(input).toHaveAttribute('aria-activedescendant', options[4]!.id);
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', options[0]!.id);
    expect(input).toHaveFocus();
  });

  it('W02 AS-05: Enter on an active option searches for it', async () => {
    suggestions(IPHONE);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    await user.type(screen.getByRole('combobox'), 'iph');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(nav.push).toHaveBeenCalledWith('/search?q=iphone+17');
  });

  it('W02 AS-05: clicking an option searches for it', async () => {
    suggestions(IPHONE);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    await user.type(screen.getByRole('combobox'), 'iph');
    await user.click(await screen.findByRole('option', { name: 'iphone charger' }));
    expect(nav.push).toHaveBeenCalledWith('/search?q=iphone+charger');
  });

  it('W02 AS-06: Enter with no active option searches the typed text', async () => {
    suggestions(IPHONE);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    await user.type(screen.getByRole('combobox'), 'espresso{Enter}');
    expect(nav.push).toHaveBeenCalledWith('/search?q=espresso');
  });

  it('W02 AS-06: Escape closes the list, a second Escape clears the text', async () => {
    suggestions(IPHONE);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    const input = screen.getByRole('combobox');
    await user.type(input, 'iph');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input).toHaveValue('iph');
    expect(input).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
  });

  it('W02 AS-06: Tab closes the list and moves on', async () => {
    suggestions(IPHONE);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    await user.type(screen.getByRole('combobox'), 'iph');
    await screen.findByRole('listbox');
    await user.tab();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('combobox')).not.toHaveFocus();
  });

  it('W02 AS-06: Down opens a closed list that has suggestions', async () => {
    suggestions(IPHONE);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    await user.type(screen.getByRole('combobox'), 'iph');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it.each([
    ['429', () => problemResponse(429, 'rate_limited', { retryAfter: 2 })],
    ['400', () => problemResponse(400, 'validation_failed')],
    ['503', () => problemResponse(503, 'service_unavailable')],
    ['invalid body', () => HttpResponse.json({ nope: true })],
    ['network', () => HttpResponse.error()],
    ['no body', () => emptyResponse(500)],
  ])('W02 AS-08: %s keeps the list closed, shows no alert, and Enter still searches', async (_name, answer) => {
    server.use(http.get('*/api/suggest', answer));
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    await user.type(screen.getByRole('combobox'), 'iph');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('combobox')).toHaveValue('iph');
    await user.keyboard('{Enter}');
    expect(nav.push).toHaveBeenCalledWith('/search?q=iph');
  });

  it('W02 AS-08: an empty 200 shows "No suggestions" and no alert', async () => {
    suggestions([]);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(await screen.findByText('No suggestions', { selector: '[role="status"]' })).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('W02 AS-09: the text is trimmed before use; a suggestion is rendered as text, never HTML', async () => {
    suggestions(['<img src=x onerror=alert(1)>']);
    const user = userEvent.setup();
    const { container } = render(wrapper(<SearchBox variant="hero" />));
    await user.type(screen.getByRole('combobox'), '  iph ');
    const option = await screen.findByRole('option');
    expect(option.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    await user.keyboard('{Escape}{Enter}');
    expect(nav.push).toHaveBeenCalledWith('/search?q=iph');
  });

  it('W02 AS-09: an empty submit goes to /search from another page', async () => {
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    await user.type(screen.getByRole('combobox'), '   {Enter}');
    expect(nav.push).toHaveBeenCalledWith('/search');
  });

  it('W02 AS-09: on /search an empty submit removes q and keeps the filters and sort; the cursor goes', async () => {
    nav.pathname = '/search';
    nav.search = 'q=shoes&category=boots&sort=price-asc&cursor=abc';
    window.history.replaceState(null, '', `/search?${nav.search}`);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="page" />));
    const input = screen.getByRole('combobox');
    expect(input).toHaveValue('shoes');
    await user.clear(input);
    await user.type(input, '{Enter}');
    expect(window.location.pathname + window.location.search).toBe('/search?category=boots&sort=price-asc');
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('W02 AS-09: on /search a new text keeps the filters and sort', async () => {
    nav.pathname = '/search';
    nav.search = 'q=shoes&category=boots&minRating=4';
    window.history.replaceState(null, '', `/search?${nav.search}`);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="page" />));
    const input = screen.getByRole('combobox');
    await user.clear(input);
    await user.type(input, 'sandals{Enter}');
    expect(window.location.search).toBe('?q=sandals&category=boots&minRating=4');
  });

  it('W02 AS-09: the initial text is the q of the address and it follows back/forward', () => {
    nav.pathname = '/search';
    nav.search = 'q=shoes';
    const { rerender } = render(wrapper(<SearchBox variant="page" />));
    expect(screen.getByRole('combobox')).toHaveValue('shoes');
    nav.search = 'q=boots';
    rerender(wrapper(<SearchBox variant="page" />));
    expect(screen.getByRole('combobox')).toHaveValue('boots');
  });

  it('W02 AS-09: a paste over 100 characters is cut to 100 with the hint', async () => {
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.paste('x'.repeat(150));
    expect((input as HTMLInputElement).value).toHaveLength(100);
    expect(screen.getByText('Search is limited to 100 characters.')).toBeInTheDocument();
  });

  it('W02 AS-09: Clear search empties the box, keeps focus in it and closes the list', async () => {
    suggestions(IPHONE);
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    const input = screen.getByRole('combobox');
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
    await user.type(input, 'iph');
    await screen.findByRole('listbox');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('W02 AS-09: the submit button is named Search', async () => {
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    await user.type(screen.getByRole('combobox'), 'tea');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(nav.push).toHaveBeenCalledWith('/search?q=tea');
  });

  it.each(['/', '/search'])('W02 AS-06: the navbar variant renders nothing on %s', (pathname) => {
    nav.pathname = pathname;
    const { container } = render(wrapper(<SearchBox variant="navbar" />));
    expect(container).toBeEmptyDOMElement();
  });

  it('W02 AS-06: the navbar variant renders the box on other pages', () => {
    nav.pathname = '/cart';
    render(wrapper(<SearchBox variant="navbar" />));
    expect(screen.getByRole('combobox', { name: 'Search products' })).toBeInTheDocument();
  });

  it('W02 AS-76: typing does not re-render the results grid', async () => {
    suggestions(IPHONE);
    let gridRenders = 0;
    const Grid = memo(function Grid() {
      gridRenders += 1;
      return <div data-testid="grid" />;
    });
    function Page() {
      const [count] = useState(0);
      return (
        <>
          <SearchBox variant="page" />
          <Grid key={count} />
        </>
      );
    }
    const user = userEvent.setup();
    render(wrapper(<Page />));
    const before = gridRenders;
    await user.type(screen.getByRole('combobox'), 'iphone');
    await screen.findByRole('listbox');
    expect(gridRenders).toBe(before);
  });

  it('W02 AS-77: the typed text is not written to the console', async () => {
    server.use(http.get('*/api/suggest', () => HttpResponse.error()));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const user = userEvent.setup();
    render(wrapper(<SearchBox variant="hero" />));
    await user.type(screen.getByRole('combobox'), 'secret-text{Enter}');
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-text');
    spies.forEach((spy) => spy.mockRestore());
  });
});
