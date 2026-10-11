/** One `application/ld+json` data block. `json` must already have its `<` escaped (`lib/seo/product-jsonld.ts`). */
export function JsonLd({ json }: { json: string }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
