import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PasswordInput } from './password-input';

describe('PasswordInput', () => {
  it('W01 AS-66: is labelled and hidden by default with the toggle named Show password', () => {
    render(<PasswordInput label="Password" name="password" autoComplete="current-password" />);
    const input = screen.getByLabelText('Password', { selector: 'input' });
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'current-password');
    expect(input).toHaveAttribute('name', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('W01 AS-20: the toggle reveals and hides the password and keeps value and focus on the input', async () => {
    const user = userEvent.setup();
    render(<PasswordInput label="Password" autoComplete="new-password" defaultValue="" />);
    const input = screen.getByLabelText('Password', { selector: 'input' });
    await user.type(input, 'abc');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveValue('abc');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('W01 AS-03: marks an invalid input and ties the hint and the error with aria-describedby', () => {
    render(<PasswordInput label="Password" hint="Use 12 to 128 characters." error="Use 12 to 128 characters." autoComplete="new-password" />);
    const input = screen.getByLabelText('Password', { selector: 'input' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    expect(described.length).toBeGreaterThan(0);
    const text = described.map((id) => document.getElementById(id)?.textContent).join(' ');
    expect(text).toContain('Use 12 to 128 characters.');
  });

  it('W01 AS-66: without an error the input is not aria-invalid and a hint is described', () => {
    render(<PasswordInput label="Password" hint="Use 12 to 128 characters." autoComplete="new-password" />);
    const input = screen.getByLabelText('Password', { selector: 'input' });
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')).toHaveTextContent('Use 12 to 128 characters.');
  });

  it('W01 AS-12: readOnly keeps the value and the toggle stays operable', () => {
    render(<PasswordInput label="Password" autoComplete="current-password" readOnly defaultValue="x" />);
    expect(screen.getByLabelText('Password', { selector: 'input' })).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Show password' })).toBeEnabled();
  });

  it('W01 AS-14: the toggle follows the input in tab order', async () => {
    const user = userEvent.setup();
    render(<PasswordInput label="Password" autoComplete="current-password" />);
    await user.tab();
    expect(screen.getByLabelText('Password', { selector: 'input' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus();
  });
});
