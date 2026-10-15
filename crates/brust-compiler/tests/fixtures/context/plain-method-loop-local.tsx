function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ fmt }: { fmt?: () => string }) {
  const rows = [{ toString: fmt }]
  return <Wrap>{rows.map((r, i) => <p key={i}>{r.toString()}</p>)}</Wrap>
}
