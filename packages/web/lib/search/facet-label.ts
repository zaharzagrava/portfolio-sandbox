/** A facet key as text: hyphens become spaces and the first letter is capitalised, nothing else (W02 FR-027). */
export function facetLabel(key: string): string {
  const text = key.replace(/-/g, ' ');
  const [first = ''] = Array.from(text);
  return first.toUpperCase() + text.slice(first.length);
}
