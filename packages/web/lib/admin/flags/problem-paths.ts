import { FLAG_LIMITS } from '@marketplace-sandbox/contracts';

/** A form control a server `path` points at: the DOM id the editor gives it and the name the summary shows. */
export type FieldTarget = { id: string; label: string };

const SIMPLE: Record<string, FieldTarget> = {
  key: { id: 'flag-key', label: 'Key' },
  description: { id: 'flag-description', label: 'Description' },
  owner: { id: 'flag-owner', label: 'Owner' },
  expiresAt: { id: 'flag-expires-at', label: 'Expires' },
  clientSide: { id: 'flag-client-side', label: 'Client-side' },
  enabled: { id: 'flag-enabled', label: 'Enabled' },
  defaultVariant: { id: 'flag-default-variant', label: 'Default variant' },
  offVariant: { id: 'flag-off-variant', label: 'Off variant' },
  bucketBy: { id: 'flag-bucket-by', label: 'Bucket by' },
  variants: { id: 'flag-variants', label: 'Variants' },
  rules: { id: 'flag-rules', label: 'Targeting rules' },
};

const VARIANT_PART: Record<string, string> = { key: 'key', value: 'value' };
const CONDITION_LABEL: Record<string, string> = { attribute: 'attribute', op: 'operator', values: 'values' };

/**
 * Maps a `path` of a `422 flag_definition_invalid` or `400 validation_failed` entry to the control that holds it (W06
 * FR-050). Ids are positional (`variant-2-value`, `rule-0-rollout`); the editor renders them from the draft's order, which is
 * the order the request was built in. `null` = no field (the summary lists it alone).
 */
export function fieldForPath(path: string): FieldTarget | null {
  const simple = SIMPLE[path];
  if (simple) return simple;

  const variant = /^variants\[(\d+)\](?:\.(key|value))?$/.exec(path);
  if (variant) {
    const index = Number(variant[1]);
    const part = VARIANT_PART[variant[2] ?? 'value']!;
    return { id: `variant-${index}-${part}`, label: `Variant ${index + 1} ${part}` };
  }

  const condition = /^rules\[(\d+)\]\.conditions\[(\d+)\](?:\.(attribute|op|values))?$/.exec(path);
  if (condition) {
    const [rule, item] = [Number(condition[1]), Number(condition[2])];
    const part = condition[3] ?? 'values';
    return { id: `rule-${rule}-condition-${item}-${part}`, label: `Rule ${rule + 1} condition ${item + 1} ${CONDITION_LABEL[part]}` };
  }

  const rule = /^rules\[(\d+)\](?:\.(id|variant|rollout)(?:\[\d+\](?:\.\w+)?)?)?$/.exec(path);
  if (rule) {
    const index = Number(rule[1]);
    const part = rule[2];
    if (part === 'rollout') return { id: `rule-${index}-rollout`, label: `Rule ${index + 1} rollout` };
    if (part === 'variant') return { id: `rule-${index}-outcome`, label: `Rule ${index + 1} variant` };
    if (part === 'id') return { id: `rule-${index}-id`, label: `Rule ${index + 1} id` };
    return { id: `rule-${index}`, label: `Rule ${index + 1}` };
  }
  return null;
}

const percent = (basisPoints: number) => `${Math.round(basisPoints) / 100}%`;

/**
 * The visible message of one `flag_definition_invalid` code (W06 error catalogue). Limits come from the contracts so a backend
 * change shows here. An unknown code is generic, with the code in `title` for the on-call.
 */
export function definitionErrorCopy(code: string, extra: { sum?: number } = {}): { message: string; title?: string } {
  switch (code) {
    case 'weights_sum_invalid':
      return {
        message: extra.sum === undefined ? 'Weights must add up to 100%.' : `Weights must add up to 100%. They add up to ${percent(extra.sum)}.`,
      };
    case 'too_many_variants':
      return { message: `A flag can have at most ${FLAG_LIMITS.variants} variants.` };
    case 'too_many_rules':
      return { message: `A flag can have at most ${FLAG_LIMITS.rules} rules.` };
    case 'too_many_conditions':
      return { message: `A rule can have at most ${FLAG_LIMITS.conditions} conditions.` };
    case 'too_many_values':
      return { message: `A condition can list at most ${FLAG_LIMITS.values} values.` };
    case 'value_too_large':
      return { message: `This value is too large (${FLAG_LIMITS.valueBytes / 1024} KiB at most).` };
    case 'description_too_long':
      return { message: `Description can be at most ${FLAG_LIMITS.description} characters.` };
    case 'owner_too_long':
      return { message: `Owner can be at most ${FLAG_LIMITS.owner} characters.` };
    case 'owner_missing':
      return { message: 'Enter an owner.' };
    case 'unknown_variant':
      return { message: 'Choose a variant that exists.' };
    case 'duplicate_variant_key':
      return { message: 'Each variant needs its own key.' };
    case 'invalid_variant_key':
      return { message: 'Use lowercase letters, digits, hyphens and underscores (32 characters at most).' };
    case 'duplicate_rule_id':
      return { message: 'Each rule needs its own id.' };
    case 'invalid_rule_id':
      return { message: 'Use lowercase letters, digits and hyphens (32 characters at most).' };
    case 'invalid_key':
      return { message: 'Use lowercase letters, digits and hyphens.' };
    case 'expires_at_in_past':
      return { message: 'Choose a time in the future.' };
    case 'expires_at_invalid':
      return { message: 'Enter a valid date and time.' };
    case 'variants_missing':
      return { message: 'Add at least one variant.' };
    case 'duplicate_rollout_variant':
      return { message: 'Each variant can appear once in a rollout.' };
    case 'rollout_size_invalid':
      return { message: `A rollout can have at most ${FLAG_LIMITS.rolloutSlices} slices.` };
    case 'weight_invalid':
      return { message: 'Enter a weight between 0% and 100%.' };
    default:
      return { message: "This value isn't valid.", title: code };
  }
}
