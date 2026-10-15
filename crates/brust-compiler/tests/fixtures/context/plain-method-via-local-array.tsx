function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ fmt }: { fmt?: () => string }) {
  const arr = [{ toString: fmt }]
  return <Wrap>{arr[0].toString()}</Wrap>
}
