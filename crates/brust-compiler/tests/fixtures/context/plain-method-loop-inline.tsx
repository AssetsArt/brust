function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ fmt }: { fmt?: () => string }) {
  return <Wrap>{[{ toString: fmt }].map((r, i) => <p key={i}>{r.toString()}</p>)}</Wrap>
}
