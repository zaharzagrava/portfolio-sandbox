/**
 * Whether a JSON object text repeats a top-level key (`{"url":"a","url":"b"}`): `JSON.parse` keeps the last one
 * silently, which hides a malformed request (S41 AS-04). A scanner for strings and nesting depth, not a parser: any
 * text it cannot follow is reported as not repeating and left to the schema.
 */
export function hasDuplicateTopLevelKey(text: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          value += text[j] + (text[j + 1] ?? '');
          j += 2;
        } else value += text[j++];
      }
      if (depth === 1 && expectKey) {
        if (seen.has(value)) return true;
        seen.add(value);
        expectKey = false;
      }
      i = j;
    } else if (c === '{' || c === '[') {
      depth++;
      if (c === '{' && depth === 1) expectKey = true;
    } else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 1) expectKey = true;
  }
  return false;
}
