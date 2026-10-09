/**
 * Structure-aware chunking (10/10 #43). Pure - no I/O - so it is unit-tested
 * in isolation and runs anywhere (worker, Lambda).
 *
 *  1. Split the document into SECTIONS along its structure (markdown
 *     headings outside code fences; numbered / ALL-CAPS heading lines in PDF
 *     text), remembering the heading path and the page.
 *  2. Pack each section's paragraphs into chunks of ~300-800 tokens; a
 *     paragraph bigger than a chunk is split by sentences, a giant sentence
 *     by characters. Consecutive chunks of one section overlap by ~80 tokens
 *     so an answer straddling a boundary is retrievable from either side.
 *  3. Tiny sibling sections (a FAQ entry each) are merged up to the minimum
 *     size instead of becoming 40-token chunks that embed poorly.
 *
 * The heading path travels with the chunk: it is embedded and indexed with
 * it ("Battery > Charging" makes "how fast does it charge" match a chunk
 * whose body never says "charge").
 */

export interface Section {
  headings: string[];
  page: number | null;
  text: string;
}

export interface Chunk {
  ordinal: number;
  headingPath: string;
  page: number | null;
  content: string;
  tokens: number;
}

export interface ChunkOptions {
  minTokens?: number;
  maxTokens?: number;
  overlapTokens?: number;
}

/** ~4 chars per token for English prose: good enough for sizing (exact counts aren't needed here). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function markdownSections(markdown: string, title: string): Section[] {
  const sections: Section[] = [];
  const stack: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text)
      sections.push({
        headings: [title, ...stack.filter(Boolean)],
        page: null,
        text,
      });
    buffer = [];
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = !inFence && MD_HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      stack.length = level - 1;
      stack[level - 1] = heading[2].trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

const NUMBERED_HEADING = /^(\d+(?:\.\d+){0,3})\.?\s+([A-Za-z][^.!?]{1,78})$/;
const CAPS_HEADING = /^[A-Z0-9][A-Z0-9 &/,()'-]{2,78}$/;

/** PDF text (one string per page) → sections. A section never spans pages, so citations can name the page. */
export function pdfSections(pages: string[], title: string): Section[] {
  const sections: Section[] = [];
  let stack: string[] = [];
  pages.forEach((pageText, i) => {
    let buffer: string[] = [];
    const flush = () => {
      const text = buffer.join('\n').trim();
      if (text)
        sections.push({ headings: [title, ...stack], page: i + 1, text });
      buffer = [];
    };
    for (const raw of pageText.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim();
      const numbered = NUMBERED_HEADING.exec(line);
      if (numbered) {
        flush();
        const level = numbered[1].split('.').length;
        stack = [...stack.slice(0, level - 1), `${numbered[1]} ${numbered[2]}`];
        continue;
      }
      if (CAPS_HEADING.test(line) && /[A-Z]{3}/.test(line)) {
        flush();
        stack = [line];
        continue;
      }
      buffer.push(raw);
    }
    flush();
  });
  return sections;
}

export function chunkSections(
  sections: Section[],
  { minTokens = 300, maxTokens = 800, overlapTokens = 80 }: ChunkOptions = {},
): Chunk[] {
  const merged = mergeSmallSiblings(sections, minTokens, maxTokens);
  const chunks: Omit<Chunk, 'ordinal'>[] = [];

  for (const section of merged) {
    const headingPath = section.headings.join(' > ');
    const units = toUnits(section.text, maxTokens);
    let current: string[] = [];
    let size = 0;

    const emit = () => {
      const content = current.join('\n\n').trim();
      if (content)
        chunks.push({
          headingPath,
          page: section.page,
          content,
          tokens: estimateTokens(content),
        });
    };

    for (const unit of units) {
      const t = estimateTokens(unit);
      if (size + t > maxTokens && current.length) {
        emit();
        // Overlap: carry the tail units that fit in the overlap budget.
        const tail: string[] = [];
        let tailSize = 0;
        for (let i = current.length - 1; i >= 0; i--) {
          const ut = estimateTokens(current[i]);
          if (tailSize + ut > overlapTokens) break;
          tail.unshift(current[i]);
          tailSize += ut;
        }
        current = tail;
        size = tailSize;
      }
      current.push(unit);
      size += t;
    }
    emit();
  }
  return chunks.map((c, ordinal) => ({ ordinal, ...c }));
}

/** Paragraphs; oversized ones → sentences; oversized sentences → hard character slices. */
function toUnits(text: string, maxTokens: number): string[] {
  const units: string[] = [];
  for (const paragraph of text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    if (estimateTokens(paragraph) <= maxTokens) {
      units.push(paragraph);
      continue;
    }
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      if (estimateTokens(sentence) <= maxTokens) units.push(sentence);
      else
        for (let i = 0; i < sentence.length; i += maxTokens * 4)
          units.push(sentence.slice(i, i + maxTokens * 4));
    }
  }
  return units;
}

/** Adjacent small sections under the same parent (and page) merge; their own headings move inline into the text. */
function mergeSmallSiblings(
  sections: Section[],
  minTokens: number,
  maxTokens: number,
): Section[] {
  type Acc = Section & { inlined: boolean };
  const out: Acc[] = [];
  const parentOf = (x: Acc) =>
    (x.inlined ? x.headings : x.headings.slice(0, -1)).join('\u0000');
  const leaf = (x: Section) => x.headings[x.headings.length - 1];

  for (const section of sections) {
    const s: Acc = { ...section, inlined: false };
    const prev = out[out.length - 1];
    const mergeable =
      prev &&
      s.headings.length > 1 &&
      (prev.inlined || prev.headings.length > 1) &&
      prev.page === s.page &&
      parentOf(prev) === parentOf(s) &&
      estimateTokens(prev.text) < minTokens &&
      estimateTokens(prev.text) + estimateTokens(s.text) <= maxTokens;
    if (!mergeable) {
      out.push(s);
      continue;
    }
    out[out.length - 1] = {
      headings: prev.inlined ? prev.headings : prev.headings.slice(0, -1),
      page: prev.page,
      text: `${prev.inlined ? prev.text : `${leaf(prev)}\n${prev.text}`}\n\n${leaf(s)}\n${s.text}`,
      inlined: true,
    };
  }
  return out.map(({ inlined: _inlined, ...section }) => section);
}

/** What gets embedded / shown to the model: the heading path gives the chunk its context. */
export const chunkText = (chunk: Pick<Chunk, 'headingPath' | 'content'>) =>
  `${chunk.headingPath}\n\n${chunk.content}`;
