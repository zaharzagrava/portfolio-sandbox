import { describe, expect, it } from 'vitest';
import { flagInputSchema, type Flag } from '@marketplace-sandbox/contracts';
import { draftReducer, isDirty, toDraft, type Draft } from './draft';
import { toFlagInput } from './to-flag-input';
import { starterDraft, STARTER_DEFINITION } from './starter';

const flag = (patch: Partial<Flag> = {}): Flag => ({
  key: 'new-checkout',
  description: 'Checkout v2',
  owner: 'admin@marketplace.local',
  status: 'disabled',
  enabled: false,
  variants: [
    { key: 'off', value: false },
    { key: 'on', value: true },
  ],
  defaultVariant: 'off',
  offVariant: 'off',
  rules: [],
  bucketBy: 'userId',
  clientSide: false,
  expiresAt: null,
  version: 3,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  ...patch,
});

const built = (draft: Draft) => {
  const result = toFlagInput(draft);
  if (!result.input) throw new Error(`expected an input, got ${JSON.stringify(result.errors)}`);
  return result.input;
};

describe('draft ↔ flag input', () => {
  it('W06 AS-18: an untouched draft produces the stored definition with the loaded version as expectedVersion', () => {
    const input = built(toDraft(flag()));
    expect(input).toEqual({
      expectedVersion: 3,
      description: 'Checkout v2',
      owner: 'admin@marketplace.local',
      enabled: false,
      variants: [
        { key: 'off', value: false },
        { key: 'on', value: true },
      ],
      defaultVariant: 'off',
      offVariant: 'off',
      rules: [],
      bucketBy: 'userId',
      clientSide: false,
      expiresAt: null,
    });
    expect(flagInputSchema.safeParse(input).success).toBe(true);
  });

  it('W06 AS-34: a killed flag is edited and saved with enabled: false', () => {
    const draft = toDraft(flag({ status: 'killed', enabled: false }));
    expect(draft.enabled).toBe(false);
    expect(built(draft).enabled).toBe(false);
    expect(built(toDraft(flag({ status: 'enabled', enabled: true }))).enabled).toBe(true);
  });

  it('W06 FR-020: an empty description is omitted and an empty expiry is null', () => {
    const draft = draftReducer(toDraft(flag()), { type: 'edit', patch: { description: '', expiresAt: '' } });
    const input = built(draft);
    expect('description' in input).toBe(false);
    expect(input.expiresAt).toBeNull();
  });

  it('W06 AS-23: percent with up to two decimals becomes integer basis points, and back', () => {
    const source = flag({
      rules: [
        {
          id: 'staff',
          conditions: [{ attribute: 'email_domain', op: 'in', values: ['example.com'] }],
          rollout: [
            { variant: 'on', weight: 500 },
            { variant: 'off', weight: 9500 },
          ],
        },
        { id: 'ramp', conditions: [], rollout: [{ variant: 'on', weight: 1250 }, { variant: 'off', weight: 8750 }] },
      ],
    });
    const draft = toDraft(source);
    const slices = (draft.rules[0]!.outcome as { kind: 'rollout'; slices: { percentText: string }[] }).slices;
    expect(slices.map((slice) => slice.percentText)).toEqual(['5', '95']);
    const second = (draft.rules[1]!.outcome as { kind: 'rollout'; slices: { percentText: string }[] }).slices;
    expect(second.map((slice) => slice.percentText)).toEqual(['12.5', '87.5']);
    expect(built(draft).rules).toEqual(source.rules);
  });

  it('W06 AS-23: a rule sends rollout or variant, never both', () => {
    let draft = toDraft(flag({ rules: [{ id: 'r1', conditions: [], variant: 'on' }] }));
    const uid = draft.rules[0]!.uid;
    expect(built(draft).rules[0]).toEqual({ id: 'r1', conditions: [], variant: 'on' });
    draft = draftReducer(draft, { type: 'setOutcomeKind', ruleUid: uid, kind: 'rollout' });
    const rule = built(draft).rules[0]!;
    expect('variant' in rule).toBe(false);
    expect(rule.rollout).toBeDefined();
    draft = draftReducer(draft, { type: 'setOutcomeKind', ruleUid: uid, kind: 'variant' });
    const back = built(draft).rules[0]!;
    expect('rollout' in back).toBe(false);
    expect(back.variant).toBeDefined();
  });

  it('W06 AS-23: a weight with more than two decimals is a syntax error before sending', () => {
    let draft = toDraft(flag({ rules: [{ id: 'r1', conditions: [], rollout: [{ variant: 'on', weight: 500 }] }] }));
    const rule = draft.rules[0]!;
    const slice = (rule.outcome as { kind: 'rollout'; slices: { uid: string }[] }).slices[0]!;
    draft = draftReducer(draft, { type: 'editSlice', ruleUid: rule.uid, uid: slice.uid, patch: { percentText: '1.234' } });
    const result = toFlagInput(draft);
    expect(result.input).toBeNull();
    expect(result.errors[0]!.message).toBe('Enter a percentage with at most two decimals.');
  });

  it('W06 AS-23: "Make the last slice the remainder" sets the last weight to 100 minus the others, never below 0', () => {
    let draft = toDraft(
      flag({ rules: [{ id: 'r1', conditions: [], rollout: [{ variant: 'on', weight: 500 }, { variant: 'off', weight: 9500 }] }] }),
    );
    const rule = draft.rules[0]!;
    draft = draftReducer(draft, { type: 'remainder', ruleUid: rule.uid });
    let slices = (draft.rules[0]!.outcome as { kind: 'rollout'; slices: { percentText: string; uid: string }[] }).slices;
    expect(slices.map((slice) => slice.percentText)).toEqual(['5', '95']);
    draft = draftReducer(draft, { type: 'editSlice', ruleUid: rule.uid, uid: slices[0]!.uid, patch: { percentText: '120' } });
    draft = draftReducer(draft, { type: 'remainder', ruleUid: rule.uid });
    slices = (draft.rules[0]!.outcome as { kind: 'rollout'; slices: { percentText: string; uid: string }[] }).slices;
    expect(slices[1]!.percentText).toBe('0');
  });

  it('W06 AS-19: variant types are inferred and values are typed on the way out', () => {
    const draft = toDraft(
      flag({
        variants: [
          { key: 'a', value: false },
          { key: 'b', value: 'hello' },
          { key: 'c', value: 2.5 },
          { key: 'd', value: { limit: 3 } },
        ],
        defaultVariant: 'a',
        offVariant: 'a',
      }),
    );
    expect(draft.variants.map((variant) => variant.type)).toEqual(['boolean', 'string', 'number', 'json']);
    expect(built(draft).variants).toEqual([
      { key: 'a', value: false },
      { key: 'b', value: 'hello' },
      { key: 'c', value: 2.5 },
      { key: 'd', value: { limit: 3 } },
    ]);
  });

  it('W06 AS-30: JSON and number syntax errors come back with the field id before anything is sent', () => {
    let draft = toDraft(flag());
    draft = draftReducer(draft, { type: 'addVariant' });
    draft = draftReducer(draft, { type: 'addVariant' });
    const [first, second] = draft.variants.slice(-2);
    draft = draftReducer(draft, { type: 'editVariant', uid: first!.uid, patch: { type: 'json', text: '{nope' } });
    draft = draftReducer(draft, { type: 'editVariant', uid: second!.uid, patch: { type: 'number', text: 'abc' } });
    const result = toFlagInput(draft);
    expect(result.input).toBeNull();
    expect(result.errors).toEqual([
      { fieldId: 'variant-2-value', message: 'Enter valid JSON.' },
      { fieldId: 'variant-3-value', message: 'Enter a number.' },
    ]);
  });

  it('W06 AS-22: condition values: one per line for lists, blank lines ignored, numbers for gte/lte, none for exists', () => {
    const source = flag({
      rules: [
        {
          id: 'r1',
          conditions: [
            { attribute: 'country', op: 'in', values: ['DE', 'FR'] },
            { attribute: 'plan', op: 'eq', values: ['pro'] },
            { attribute: 'userId', op: 'gte', values: [5] },
            { attribute: 'role', op: 'exists', values: [] },
          ],
          variant: 'on',
        },
      ],
    });
    let draft = toDraft(source);
    expect(draft.rules[0]!.conditions.map((condition) => condition.valuesText)).toEqual(['DE\nFR', 'pro', '5', '']);
    expect(built(draft).rules).toEqual(source.rules);
    const rule = draft.rules[0]!;
    draft = draftReducer(draft, { type: 'editCondition', ruleUid: rule.uid, uid: rule.conditions[0]!.uid, patch: { valuesText: 'DE\n\n  \nFR\nES\n' } });
    expect(built(draft).rules[0]!.conditions[0]!.values).toEqual(['DE', 'FR', 'ES']);
  });

  it('W06 AS-22: changing the operator keeps what still applies and drops what does not', () => {
    let draft = toDraft(flag({ rules: [{ id: 'r1', conditions: [{ attribute: 'country', op: 'in', values: ['DE', 'FR'] }], variant: 'on' }] }));
    const rule = draft.rules[0]!;
    const condition = rule.conditions[0]!;
    draft = draftReducer(draft, { type: 'editCondition', ruleUid: rule.uid, uid: condition.uid, patch: { op: 'eq' } });
    expect(draft.rules[0]!.conditions[0]!.valuesText).toBe('DE');
    draft = draftReducer(draft, { type: 'editCondition', ruleUid: rule.uid, uid: condition.uid, patch: { op: 'exists' } });
    expect(draft.rules[0]!.conditions[0]!.valuesText).toBe('');
    expect(built(draft).rules[0]!.conditions[0]).toEqual({ attribute: 'country', op: 'exists', values: [] });
  });

  it('W06 AS-19: removing a referenced variant clears the choice (default, off, rule outcome, slice) instead of reassigning', () => {
    let draft = toDraft(
      flag({
        rules: [
          { id: 'r1', conditions: [], variant: 'on' },
          { id: 'r2', conditions: [], rollout: [{ variant: 'on', weight: 100 }, { variant: 'off', weight: 9900 }] },
        ],
        defaultVariant: 'on',
      }),
    );
    const on = draft.variants.find((variant) => variant.key === 'on')!;
    draft = draftReducer(draft, { type: 'removeVariant', uid: on.uid });
    expect(draft.variants.map((variant) => variant.key)).toEqual(['off']);
    expect(draft.defaultVariant).toBe('');
    expect(draft.offVariant).toBe('off');
    expect(draft.rules[0]!.outcome).toEqual({ kind: 'variant', variant: '' });
    const rollout = draft.rules[1]!.outcome as { kind: 'rollout'; slices: { variant: string }[] };
    expect(rollout.slices.map((slice) => slice.variant)).toEqual(['', 'off']);
  });

  it('W06 AS-21: rules are added with a unique id, moved, removed; moving at the ends does nothing', () => {
    let draft = toDraft(flag());
    draft = draftReducer(draft, { type: 'addRule' });
    draft = draftReducer(draft, { type: 'addRule' });
    expect(draft.rules.map((rule) => rule.id)).toEqual(['rule-1', 'rule-2']);
    const [one, two] = draft.rules;
    draft = draftReducer(draft, { type: 'moveRule', uid: two!.uid, direction: -1 });
    expect(draft.rules.map((rule) => rule.id)).toEqual(['rule-2', 'rule-1']);
    const unchanged = draftReducer(draft, { type: 'moveRule', uid: two!.uid, direction: -1 });
    expect(unchanged.rules.map((rule) => rule.id)).toEqual(['rule-2', 'rule-1']);
    draft = draftReducer(draft, { type: 'removeRule', uid: one!.uid });
    expect(draft.rules.map((rule) => rule.id)).toEqual(['rule-2']);
    expect(built(draft).rules[0]).toEqual({ id: 'rule-2', conditions: [], variant: 'off' });
  });

  it('W06 AS-25: dirty means different from what was loaded; editing back is clean; reset adopts the server answer', () => {
    const loaded = toDraft(flag());
    expect(isDirty(loaded)).toBe(false);
    const edited = draftReducer(loaded, { type: 'edit', patch: { description: 'changed' } });
    expect(isDirty(edited)).toBe(true);
    expect(isDirty(draftReducer(edited, { type: 'edit', patch: { description: 'Checkout v2' } }))).toBe(false);
    const saved = draftReducer(edited, { type: 'reset', flag: flag({ description: 'changed', version: 4 }) });
    expect(isDirty(saved)).toBe(false);
    expect(saved.basisVersion).toBe(4);
    expect(built(saved).expectedVersion).toBe(4);
  });

  it('W06 AS-26: a refetch never touches the draft: only reset does', () => {
    const edited = draftReducer(toDraft(flag()), { type: 'edit', patch: { description: 'mine' } });
    expect(edited.basisVersion).toBe(3);
    expect(draftReducer(edited, { type: 'edit', patch: {} }).description).toBe('mine');
  });

  it('W06 AS-09: the starter is a dark on/off flag that the contracts accept with expectedVersion 0', () => {
    expect(STARTER_DEFINITION).toMatchObject({ enabled: false, defaultVariant: 'off', offVariant: 'off', bucketBy: 'userId', clientSide: false, expiresAt: null, rules: [] });
    expect(STARTER_DEFINITION.variants).toEqual([
      { key: 'off', value: false },
      { key: 'on', value: true },
    ]);
    const input = built(starterDraft({ key: 'smoke-1', owner: 'admin@marketplace.local', description: '' }));
    expect(input.expectedVersion).toBe(0);
    expect(input.enabled).toBe(false);
    expect(flagInputSchema.safeParse(input).success).toBe(true);
  });

  it('W06 FR-007: a rule with a feature the editor cannot show is kept read-only and sent back unchanged', () => {
    const odd = { id: 'future', conditions: [{ attribute: 'device', op: 'matches', values: ['x'] }], variant: 'on' };
    const source = flag({ rules: [odd as never] });
    const draft = toDraft(source);
    expect(draft.rules[0]!.outcome.kind).toBe('raw');
    expect(built(draft).rules).toEqual([odd]);
  });
});
