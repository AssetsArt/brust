// F173 (lead ruling on @57714ece): every allowlisted built-in method, called as a child of a plain wrapper.
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ when = '2024-01-02T03:04:05Z' }: { when?: string }) {
  const n = 1234.5678
  const s = '  Hi there  '
  return (
    <Wrap>
      <p>{n.toString()}|{n.toLocaleString()}|{n.toFixed(2)}|{n.toPrecision(3)}</p>
      <p>{new Date(when).toLocaleString()}|{new Date(when).toLocaleDateString()}|{new Date(when).toLocaleTimeString()}</p>
      <p>{new Date(when).toISOString()}|{new Date(when).toDateString()}|{new Date(when).toTimeString()}</p>
      <p>{s.padStart(16, '*')}|{s.padEnd(16, '*')}|{s.toUpperCase()}|{s.toLowerCase()}</p>
      <p>{s.trim()}|{s.trimStart()}|{s.trimEnd()}|{s.replace('Hi', 'Yo')}|{s.replaceAll(' ', '_')}</p>
    </Wrap>
  )
}
