function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ fmt }: { fmt?: () => string }) {
  return <Wrap>{[{ o: { toString: fmt } }].map((r, k) => <p key={k}>{r.o.toString()}</p>)}</Wrap>
}
