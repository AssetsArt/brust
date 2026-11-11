export default function Other({ calls }: { calls: number }) {
  return (
    <main>
      <p data-testid="calls">{calls}</p>
      <a href="/" data-testid="to-list">
        list
      </a>
    </main>
  )
}
