function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ fmt }: { fmt?: () => string }) {
  const o = Object.fromEntries([['toString', fmt]])
  return <Wrap>{o.toString()}</Wrap>
}
