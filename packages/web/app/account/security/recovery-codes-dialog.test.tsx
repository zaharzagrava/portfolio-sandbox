import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import { toast } from 'sonner';
import { RecoveryCodesDialog } from './recovery-codes-dialog';

const CODES = ['ABCDE-FGHJK', 'MNPQR-STUVW', 'XYZ23-45678', 'ABCD2-34567', 'BCDEF-GHJKM', 'NPQRS-TUVWX', 'YZ234-56789', 'CDEFG-HJKMN', 'PQRST-UVWXY', 'Z2345-6789A'];

function Harness({ client }: { client: QueryClient }) {
  const [codes, setCodes] = useState<string[] | null>(CODES);
  return (
    <QueryClientProvider client={client}>
      <button type="button">outside</button>
      {codes && <RecoveryCodesDialog codes={codes} onDone={() => setCodes(null)} />}
    </QueryClientProvider>
  );
}

const done = () => screen.getByRole('button', { name: 'Done' });
const mount = () => {
  const client = new QueryClient();
  render(<Harness client={client} />);
  return client;
};

describe('RecoveryCodesDialog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-47: shows the ten codes with the warning, and Done is disabled until the box is ticked', async () => {
    const user = userEvent.setup();
    mount();
    const dialog = screen.getByRole('dialog', { name: 'Save your recovery codes' });
    expect(dialog).toHaveTextContent("Store these somewhere safe. You won't see them again.");
    for (const code of CODES) expect(dialog).toHaveTextContent(code);
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(done()).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: "I've saved these codes" }));
    expect(done()).toBeEnabled();
  });

  it('W01 AS-47: Escape and an outside click do not close the dialog before the box is ticked', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mount();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(document.querySelector('[data-slot="dialog-overlay"]') as HTMLElement);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('W01 AS-47: leaving the page while the dialog is open triggers the browser prompt; it is removed after close', async () => {
    const user = userEvent.setup();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    mount();
    expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: "I've saved these codes" }));
    await user.click(done());
    expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('W01 AS-47: Copy all copies the codes one per line; Download .txt offers a text file', async () => {
    const user = userEvent.setup();
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      created.push(blob as Blob);
      return 'blob:codes';
    });
    URL.revokeObjectURL = vi.fn();
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    mount();
    await user.click(screen.getByRole('button', { name: 'Copy all' }));
    expect(await navigator.clipboard.readText()).toBe(CODES.join('\n'));
    expect(toast.success).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Download .txt' }));
    expect(downloads).toEqual(['recovery-codes.txt']);
    expect(created).toHaveLength(1);
    expect(created[0].type).toMatch(/^text\/plain/);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:codes');
  });

  it('W01 AS-47: after Done the codes exist nowhere: not in the DOM, the query cache or storage', async () => {
    const user = userEvent.setup();
    const client = mount();
    await user.click(screen.getByRole('checkbox', { name: "I've saved these codes" }));
    await user.click(done());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(CODES[0]);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify({ ...localStorage })).not.toContain(CODES[0]);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(CODES[0]);
    expect(window.location.href).not.toContain(CODES[0]);
  });
});
