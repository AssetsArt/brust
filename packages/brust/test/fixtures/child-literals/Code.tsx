// The child's line list is a precompute job over its props (a callback), so every instance is fed.
export default function Code({ code, lang }: { code: string; lang: string }) {
  return (
    <pre data-lang={lang}>
      {code
        .split('\n')
        .filter((l) => l.length > 0)
        .join('|')}
    </pre>
  )
}
