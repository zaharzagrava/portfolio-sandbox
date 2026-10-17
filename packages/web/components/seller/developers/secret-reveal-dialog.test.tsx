import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installClipboardStub, type ClipboardStub } from '@/lib/test/clipboard-stub';
import { RevealSecretDialog } from '../secret-reveal-dialog';

const SECRET = 'sk_test_abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

function Harness({ onDone = () => {} }: { onDone?: () => void }) {
  const [secret, setSecret] = useState<string | null>(SECRET);
  return (
    <RevealSecretDialog
      title="Save your API key"
      description="This is the only time the full key is shown."
      secret={secret}
      note="The old key keeps working until tomorrow."
      onDone={() => {
        setSecret(null);
        onDone();
      }}
    />
  );
}

describe('W04 RevealSecretDialog', () => {
  let clipboard: ClipboardStub;
  const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) => vi.spyOn(console, method as 'log').mockImplementation(() => {}));

  let mode: 'granted' | 'denied' = 'granted';
  /** user-event installs its own clipboard when set up, so the stub goes in after it. */
  function setup(options?: Parameters<typeof userEvent.setup>[0]) {
    const user = userEvent.setup(options);
    clipboard = installClipboardStub(mode);
    return user;
  }

  beforeEach(() => {
    mode = 'granted';
    clipboard = installClipboardStub('granted');
    for (const spy of consoleSpies) spy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('W04 AS-45: shows the title, the full key, a Copy button and a Done button', () => {
    render(<Harness />);
    expect(screen.getByRole('dialog', { name: 'Save your API key' })).toBeInTheDocument();
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    expect(screen.getByText('The old key keeps working until tomorrow.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('W04 AS-46: nothing is shown without a secret', () => {
    render(<RevealSecretDialog title="t" description="d" secret={null} onDone={() => {}} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('W04 AS-46: Escape and a click outside do not close the dialog', async () => {
    const user = setup();
    const onDone = vi.fn();
    render(<Harness onDone={onDone} />);
    await user.keyboard('{Escape}');
    const overlay = document.querySelector('[data-slot="dialog-overlay"]') as Element;
    fireEvent.pointerDown(overlay);
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('W04 AS-46: Done before Copy asks once, with Close anyway and Copy key', async () => {
    const user = setup();
    const onDone = vi.fn();
    render(<Harness onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText("You haven't copied this key. It can't be shown again.")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close anyway' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close anyway' }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it('W04 AS-46: Copy key in the warning copies, and Done then closes without asking again', async () => {
    const user = setup();
    const onDone = vi.fn();
    render(<Harness onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Copy key' }));
    expect(clipboard.written).toEqual([SECRET]);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('W04 AS-46: after Copy, Done closes at once, with no warning', async () => {
    const user = setup();
    const onDone = vi.fn();
    render(<Harness onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(/haven't copied/)).not.toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('W04 AS-47: Copy reads "Copied" for 2 seconds and announces "Copied to clipboard"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(clipboard.written).toEqual([SECRET]);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Copied to clipboard');
    await act(() => vi.advanceTimersByTimeAsync(1900));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('W04 AS-47: a denied clipboard selects the key text and says how to copy by hand', async () => {
    mode = 'denied';
    const user = setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByText('Press Ctrl+C (⌘C on Mac) to copy.')).toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe(SECRET);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('W04 AS-47: after a denied copy the seller copying by hand counts as copied', async () => {
    mode = 'denied';
    const user = setup();
    const onDone = vi.fn();
    render(<Harness onDone={onDone} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await act(async () => {
      screen.getByText(SECRET).dispatchEvent(new Event('copy', { bubbles: true }));
    });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(/haven't copied/)).not.toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('W04 AS-46: the secret is in the dialog and nowhere else: query cache, URL, storage, console', async () => {
    const user = setup();
    const client = new QueryClient();
    window.localStorage.clear();
    window.sessionStorage.clear();
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    const everything = JSON.stringify({
      queries: client.getQueryCache().getAll().map((q) => [q.queryKey, q.state.data]),
      mutations: client.getMutationCache().getAll().map((m) => m.state),
      url: window.location.href,
      local: { ...window.localStorage },
      session: { ...window.sessionStorage },
      cookie: document.cookie,
      console: consoleSpies.flatMap((spy) => spy.mock.calls),
      title: document.title,
    });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
  });

  it('W04 AS-46: after Done the key is gone from the page and the form can be reused', async () => {
    const user = setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('W04 AS-94: opening moves focus inside the dialog, and closing returns it to the control that opened it', async () => {
    const user = setup();
    function Opener() {
      const [secret, setSecret] = useState<string | null>(null);
      return (
        <>
          <button onClick={() => setSecret(SECRET)}>Create key</button>
          <RevealSecretDialog title="Save your API key" description="Once." secret={secret} onDone={() => setSecret(null)} />
        </>
      );
    }
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create key' })).toHaveFocus());
  });
});
