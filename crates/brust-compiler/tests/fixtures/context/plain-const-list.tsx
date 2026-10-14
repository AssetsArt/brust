const tags = Array.from({ length: 4 }).map((_, i, a) => `v1.0.${a.length - i}`)
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{tags.map((t) => <p key={t}>{t}</p>)}</Wrap>
}
