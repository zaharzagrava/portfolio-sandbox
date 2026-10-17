import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

function Harness({ onConfirm, error }: { onConfirm: () => void | Promise<void>; error?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Revoke</button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Revoke key?"
        description="Every request with this key will be refused right away. This can't be undone."
        confirmLabel="Revoke key"
        destructive
        error={error ? <p role="alert">{error}</p> : undefined}
        onConfirm={async () => {
          await onConfirm();
          setOpen(false);
        }}
      />
    </>
  );
}

describe('W04 ConfirmDialog', () => {
  it('W04 AS-53: focus starts on Cancel, never on the destructive button, and the description is read', async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke key?' });
    expect(dialog).toHaveAccessibleDescription("Every request with this key will be refused right away. This can't be undone.");
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('W04 AS-94: Escape closes it and focus returns to the control that opened it', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke' })).toHaveFocus());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('W04 AS-94: Tab stays inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('W04 AS-53: a double press sends one request, and the button says it is working', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const confirm = screen.getByRole('button', { name: 'Revoke key' });
    await user.dblClick(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Revoke key' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('W04 AS-52: a failed confirm keeps the dialog open, shows the error and allows another try', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    render(<Harness onConfirm={onConfirm} error="This key is already revoked." />);
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Revoke key' }));
    expect(screen.getByRole('alert')).toHaveTextContent('This key is already revoked.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke key' }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});
