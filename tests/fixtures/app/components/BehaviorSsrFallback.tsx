export const behavior = () => ({
  activate() {},
})

export default function BehaviorSsrFallback({ label }: { label: string }) {
  const renderedLabel = label.toUpperCase()
  const literal = 'source-preserved'
  return (
    <section className="behavior-ssr-fallback" x-on-click="activate">
      <strong>{renderedLabel}</strong>
      <span>{literal}</span>
      <ol className="static-array-from">
        {Array.from({ length: 2 }).map((_, index) => (
          <li key={index}>{index}</li>
        ))}
      </ol>
    </section>
  )
}
