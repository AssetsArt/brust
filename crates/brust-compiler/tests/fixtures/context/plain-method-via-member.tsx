function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ fmt }: { fmt?: () => string }) {
  const box = { o: { toString: fmt } }
  return <Wrap>{box.o.toString()}</Wrap>
}
