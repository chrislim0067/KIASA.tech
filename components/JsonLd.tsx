/** Structured data blocks copied verbatim from the original pages. */
export function JsonLd({ blocks }: { blocks: string[] }) {
  return (
    <>
      {blocks.map((json, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
      ))}
    </>
  );
}
