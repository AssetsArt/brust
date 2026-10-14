function show(x: { toString(): string }) {
  return x.toString()
}

function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ fmt }: { fmt?: () => string }) {
  return <Wrap>{show({ toString: fmt })}</Wrap>
}
