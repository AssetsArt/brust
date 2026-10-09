export default function Badge({ tone, children }: { tone: string; children: unknown }) {
  return <span className={`badge ${tone}`}>{children}</span>
}
