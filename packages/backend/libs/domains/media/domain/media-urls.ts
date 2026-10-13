export interface VariantRef {
  key: string;
  width: number;
  height: number;
}
export type Variants = Record<'thumb' | 'feed' | 'full', VariantRef>;
export interface MediaUrls {
  thumb: string;
  feed: string;
  full: string;
}

/** Every URL a client sees is `<media origin>/<derived key>`; never a storage endpoint, never an original (AS-55). */
export function toUrls(variants: Variants, origin: string): MediaUrls {
  const base = origin.replace(/\/+$/, '');
  return {
    thumb: `${base}/${variants.thumb.key}`,
    feed: `${base}/${variants.feed.key}`,
    full: `${base}/${variants.full.key}`,
  };
}
