export default function Other({ calls, refusals }: { calls: number; refusals: string }) {
  return (
    <main>
      <p data-testid="calls">{calls}</p>
      <p data-testid="refusals">{refusals}</p>
      <a href="/" data-testid="to-list">
        list
      </a>
    </main>
  )
}
