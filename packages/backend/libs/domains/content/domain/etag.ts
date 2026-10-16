/**
 * The strong entity tag of a served story: `"<id>-v<version>-<locale>"` (S27 FR-021). A republish or another served
 * locale changes it. The `If-None-Match` evaluation (list, weak, `*`) is the cache toolkit's (S52 `withEtag` /
 * `VersionEtagInterceptor`).
 */
export const storyEtag = (
  storyId: string,
  version: number,
  locale: string,
): string => `"${storyId}-v${version}-${locale}"`;
