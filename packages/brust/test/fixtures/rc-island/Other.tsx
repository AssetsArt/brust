export default function Other({ renders, pages }: { renders: number; pages: string }) {
  return (
    <main>
      <p data-testid="renders">{renders}</p>
      <p data-testid="pages">{pages}</p>
      <a href="/" data-testid="to-list">
        list
      </a>
    </main>
  )
}
