import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useReducer } from 'react';
import { describe, expect, it } from 'vitest';
import { draftReducer, toDraft, type Draft } from '@/lib/admin/flags/draft';
import { toFlagInput } from '@/lib/admin/flags/to-flag-input';
import { flagFixture } from '@/lib/test/flag-fixtures';
import { RulesEditor } from './rules-editor';

let latest: Draft;
function Harness({ flag = flagFixture(), issues = {}, readOnly = false }: { flag?: ReturnType<typeof flagFixture>; issues?: Record<string, string>; readOnly?: boolean }) {
  const [draft, dispatch] = useReducer(draftReducer, flag, toDraft);
  useEffect(() => {
    latest = draft;
  }, [draft]);
  return <RulesEditor draft={draft} dispatch={dispatch} issues={issues} readOnly={readOnly} />;
}

const withRules = (n = 2) =>
  flagFixture({
    rules: Array.from({ length: n }, (_, i) => ({
      id: `rule-${i + 1}`,
      conditions: [{ attribute: 'email_domain' as const, op: 'in' as const, values: ['example.com'] }],
      variant: 'on',
    })),
  });

const rule = (n: number) => screen.getByRole('group', { name: new RegExp(`^Rule ${n}\\b`) });

describe('RulesEditor', () => {
  it('W06 AS-21: an empty list says what happens, and Add rule appends a rule with a fixed outcome', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByText('No rules. Everyone gets the default variant.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(latest.rules).toHaveLength(1);
    expect(latest.rules[0]!.outcome.kind).toBe('variant');
    expect(latest.rules[0]!.conditions).toEqual([]);
    expect(screen.queryByText('No rules. Everyone gets the default variant.')).not.toBeInTheDocument();
  });

  it('W06 AS-21: the rules are an ordered list named for the first-match rule', () => {
    render(<Harness flag={withRules()} />);
    const list = screen.getByRole('list', { name: 'Targeting rules, checked top to bottom; the first match wins' });
    expect(list.tagName).toBe('OL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('W06 AS-21: Move rule down/up reorders, announces the new position and keeps focus on the pressed button', async () => {
    const user = userEvent.setup();
    render(<Harness flag={withRules(3)} />);
    await user.click(screen.getByRole('button', { name: 'Move rule 1 down' }));
    expect(latest.rules.map((r) => r.id)).toEqual(['rule-2', 'rule-1', 'rule-3']);
    expect(screen.getByRole('status')).toHaveTextContent('Rule rule-1 moved to position 2');
    expect(screen.getByRole('button', { name: 'Move rule 2 down' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Move rule 2 up' }));
    expect(latest.rules.map((r) => r.id)).toEqual(['rule-1', 'rule-2', 'rule-3']);
    expect(screen.getByRole('status')).toHaveTextContent('Rule rule-1 moved to position 1');
  });

  it('W06 AS-21: the first rule cannot move up and the last cannot move down', async () => {
    const user = userEvent.setup();
    render(<Harness flag={withRules(2)} />);
    expect(screen.getByRole('button', { name: 'Move rule 1 up' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Move rule 2 down' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Move rule 1 up' }));
    expect(latest.rules.map((r) => r.id)).toEqual(['rule-1', 'rule-2']);
  });

  it('W06 AS-21: Remove rule removes it', async () => {
    const user = userEvent.setup();
    render(<Harness flag={withRules(2)} />);
    await user.click(screen.getByRole('button', { name: 'Remove rule 1' }));
    expect(latest.rules.map((r) => r.id)).toEqual(['rule-2']);
  });

  it('W06 AS-22: a condition has Attribute, Operator and Values inputs that follow the operator', async () => {
    const user = userEvent.setup();
    render(<Harness flag={withRules(1)} />);
    const condition = within(screen.getByRole('group', { name: 'Condition 1' }));
    expect(within(condition.getByLabelText('Attribute')).getAllByRole('option').map((o) => o.textContent)).toEqual(['userId', 'shopId', 'role', 'email_domain', 'country', 'platform', 'plan']);
    expect(within(condition.getByLabelText('Operator')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'is one of', 'is not one of', 'equals', 'does not equal', 'at least', 'at most', 'is set',
    ]);
    expect(condition.getByLabelText('Values').tagName).toBe('TEXTAREA');
    await user.selectOptions(condition.getByLabelText('Operator'), 'eq');
    expect(condition.getByLabelText('Values').tagName).toBe('INPUT');
    await user.selectOptions(condition.getByLabelText('Operator'), 'gte');
    expect(condition.getByLabelText('Values')).toHaveAttribute('inputmode', 'decimal');
    await user.selectOptions(condition.getByLabelText('Operator'), 'exists');
    expect(condition.queryByLabelText('Values')).not.toBeInTheDocument();
  });

  it('W06 AS-22: values are one per line and blank lines are ignored', async () => {
    const user = userEvent.setup();
    render(<Harness flag={withRules(1)} />);
    const values = screen.getByLabelText('Values');
    await user.clear(values);
    await user.type(values, 'DE{Enter}{Enter}FR');
    expect(toFlagInput(latest).input!.rules[0]!.conditions[0]!.values).toEqual(['DE', 'FR']);
  });

  it('W06 AS-22: Add condition and Remove condition {n} of rule {id}', async () => {
    const user = userEvent.setup();
    render(<Harness flag={withRules(1)} />);
    await user.click(within(rule(1)).getByRole('button', { name: 'Add condition' }));
    expect(latest.rules[0]!.conditions).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Remove condition 1 of rule rule-1' }));
    expect(latest.rules[0]!.conditions).toHaveLength(1);
  });

  it('W06 AS-23: a percentage rollout shows slices in percent, a live total and the remainder button', async () => {
    const user = userEvent.setup();
    render(<Harness flag={flagFixture({ rules: [{ id: 'ramp', conditions: [], rollout: [{ variant: 'on', weight: 500 }, { variant: 'off', weight: 1250 }] }] })} />);
    const weights = screen.getAllByLabelText('Weight (%)');
    expect(weights.map((w) => (w as HTMLInputElement).value)).toEqual(['5', '12.5']);
    expect(screen.getByText('Total: 17.5%')).toBeInTheDocument();
    expect(screen.getByText('Raising a percentage only adds visitors; nobody who already has the variant loses it.')).toBeInTheDocument();
    await user.clear(weights[0]!);
    await user.type(weights[0]!, '10');
    expect(screen.getByText('Total: 22.5%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Make the last slice the remainder' }));
    expect(screen.getByText('Total: 100%')).toBeInTheDocument();
    expect(toFlagInput(latest).input!.rules[0]!.rollout).toEqual([{ variant: 'on', weight: 1000 }, { variant: 'off', weight: 9000 }]);
  });

  it('W06 AS-23: switching between Fixed variant and Percentage rollout swaps the outcome and never sends both', async () => {
    const user = userEvent.setup();
    render(<Harness flag={withRules(1)} />);
    const group = within(rule(1));
    await user.click(group.getByRole('radio', { name: 'Percentage rollout' }));
    expect(latest.rules[0]!.outcome.kind).toBe('rollout');
    const sent = toFlagInput(latest).input!.rules[0]! as Record<string, unknown>;
    expect('variant' in sent).toBe(false);
    await user.click(group.getByRole('radio', { name: 'Fixed variant' }));
    const back = toFlagInput(latest).input!.rules[0]! as Record<string, unknown>;
    expect('rollout' in back).toBe(false);
  });

  it('W06 AS-21: a rule with a feature the editor cannot show is read-only JSON with a notice, and can still be moved or removed', async () => {
    const user = userEvent.setup();
    const odd = { id: 'future', conditions: [{ attribute: 'device', op: 'matches', values: ['x'] }], variant: 'on' };
    // The contracts' strict enums would refuse this body, so the fixture is built around the parse (forward compatibility, V.7).
    render(<Harness flag={{ ...flagFixture(), rules: [odd as never, ...withRules(1).rules] }} />);
    const group = within(rule(1));
    expect(group.getByText("This rule uses a feature this editor can't show yet. Edit is disabled for it.")).toBeInTheDocument();
    expect(group.getByText(/"matches"/)).toBeInTheDocument();
    expect(group.queryByLabelText('Attribute')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove rule 1' }));
    expect(latest.rules).toHaveLength(1);
  });

  it('W06 AS-61: a rule is a disclosure named with its summary; flags with up to three rules start expanded', async () => {
    const user = userEvent.setup();
    render(<Harness flag={withRules(2)} />);
    const toggle = screen.getByRole('button', { name: /^Rule 1: / });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('W06 AS-14: a server message for a rule field is shown at the rule and linked to the control', () => {
    render(<Harness flag={flagFixture({ rules: [{ id: 'ramp', conditions: [], rollout: [{ variant: 'on', weight: 500 }] }] })} issues={{ 'rule-0-rollout': 'Weights must add up to 100%. They add up to 5%.' }} />);
    expect(screen.getByText('Weights must add up to 100%. They add up to 5%.')).toBeInTheDocument();
    expect(document.getElementById('rule-0-rollout')).toHaveAccessibleDescription(/Weights must add up to 100%/);
  });

  it('W06 AS-58: groups use fieldset and legend (Rule n, Condition n)', () => {
    render(<Harness flag={withRules(1)} />);
    expect(rule(1).tagName).toBe('FIELDSET');
    expect(screen.getByRole('group', { name: 'Condition 1' }).tagName).toBe('FIELDSET');
  });

  it('W06 AS-34: a read-only editor offers no way to change anything', () => {
    render(<Harness flag={withRules(1)} readOnly />);
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove rule 1' })).toBeDisabled();
    expect(screen.getByLabelText('Values')).toBeDisabled();
  });
});
