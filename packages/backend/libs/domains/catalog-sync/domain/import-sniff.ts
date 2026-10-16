/** What the first 4 KiB of an upload really is (S07 FR-011): decided by content, never by file name or declared type. */
export const SNIFF_WINDOW_BYTES = 4096;

export type SniffResult =
  | { ok: true; format: 'csv' | 'jsonl'; bomLength: 0 | 3 }
  | {
      ok: false;
      reason:
        'archive' | 'document' | 'image' | 'executable' | 'encoding' | 'binary';
    };

type Reason = Extract<SniffResult, { ok: false }>['reason'];

const SIGNATURES: Array<[Reason, number[]]> = [
  ['archive', [0x50, 0x4b, 0x03, 0x04]],
  ['archive', [0x50, 0x4b, 0x05, 0x06]],
  ['archive', [0x50, 0x4b, 0x07, 0x08]],
  ['archive', [0x1f, 0x8b]],
  ['document', [0x25, 0x50, 0x44, 0x46]],
  ['document', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  ['image', [0x89, 0x50, 0x4e, 0x47]],
  ['image', [0xff, 0xd8, 0xff]],
  ['image', [0x47, 0x49, 0x46, 0x38]],
  ['executable', [0x7f, 0x45, 0x4c, 0x46]],
  ['executable', [0x4d, 0x5a]],
  // UTF-32 before UTF-16: they share the first two bytes
  ['encoding', [0xff, 0xfe, 0x00, 0x00]],
  ['encoding', [0x00, 0x00, 0xfe, 0xff]],
  ['encoding', [0xff, 0xfe]],
  ['encoding', [0xfe, 0xff]],
];

const startsWith = (head: Buffer, signature: number[]) =>
  head.length >= signature.length && signature.every((b, i) => head[i] === b);

export function sniff(input: Buffer): SniffResult {
  const head = input.subarray(0, SNIFF_WINDOW_BYTES);
  for (const [reason, signature] of SIGNATURES)
    if (startsWith(head, signature)) return { ok: false, reason };
  if (head.includes(0)) return { ok: false, reason: 'binary' };
  try {
    // `stream: true` keeps a multi-byte character cut by the window from being an error
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
  } catch {
    return { ok: false, reason: 'encoding' };
  }
  const bomLength = startsWith(head, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  let at = bomLength;
  while (
    at < head.length &&
    (head[at] === 0x20 ||
      head[at] === 0x09 ||
      head[at] === 0x0a ||
      head[at] === 0x0d)
  )
    at++;
  return {
    ok: true,
    format: head[at] === 0x7b ? 'jsonl' : 'csv',
    bomLength,
  };
}
