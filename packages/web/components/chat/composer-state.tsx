import type { ComposerState } from '@/lib/chat/composer-rules';

/**
 * The visible reason the composer is off (W05 FR-028, AS-18): banned, muted, archived. Always text next to the field, never
 * only a disabled look. A failed load is explained by the notice above the list, so it adds no second line here.
 */
export function ComposerStateLine({ state }: { state: ComposerState }) {
  if (state.enabled || state.reason === 'load-failed') return null;
  return (
    <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
      {state.text}
    </p>
  );
}
