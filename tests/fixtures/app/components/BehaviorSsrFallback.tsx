import BehaviorBadge from './BehaviorBadge'

export const behavior = ({ el }: { el: HTMLElement }) => ({
  activate() {
    el.dataset.activated = 'true'
  },
})

export default function BehaviorSsrFallback({ label }: { label: string }) {
  const renderedLabel = label.toUpperCase()
  const literal = 'source-preserved'
  return (
    <section className="behavior-ssr-fallback" x-on-click="activate">
      <strong className="referenced-computed">{renderedLabel}</strong>
      <span className="referenced-literal">{literal}</span>
      <BehaviorBadge label={label} />
      <ol className="static-array-from">
        {Array.from({ length: 2 }).map((_, index) => (
          <li key={index}>{index}</li>
        ))}
      </ol>
    </section>
  )
}
