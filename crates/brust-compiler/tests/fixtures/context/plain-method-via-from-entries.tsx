function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ fmt }: { fmt?: () => string }) {

  return <Wrap>{Object.fromEntries([['toString', fmt]]).toString()}</Wrap>
}
