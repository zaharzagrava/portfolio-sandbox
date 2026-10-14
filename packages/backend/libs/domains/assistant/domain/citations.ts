import type { AnswerBlock } from './ports';

export interface AnswerCitations {
  citations: { text: string; sources: number[] }[];
  /** True only when at least one block carries at least one valid source index. */
  grounded: boolean;
}

/**
 * Per answer text block, the source numbers (indexes into the `sources` event) the provider's structured citation data
 * says support it (S47 AS-12, FR-035). Indexes outside `0…itemCount-1` and citations of another location kind are
 * dropped, duplicates collapse in order of first appearance, and empty text is dropped.
 */
export function citationsOf(
  blocks: AnswerBlock[],
  itemCount: number,
): AnswerCitations {
  const citations = blocks
    .filter((b) => b.text)
    .map((b) => ({
      text: b.text,
      sources: [
        ...new Set(
          b.citations
            .filter((c) => c.kind === 'result')
            .map((c) => c.index)
            .filter((i) => Number.isInteger(i) && i >= 0 && i < itemCount),
        ),
      ],
    }));
  return { citations, grounded: citations.some((c) => c.sources.length > 0) };
}
