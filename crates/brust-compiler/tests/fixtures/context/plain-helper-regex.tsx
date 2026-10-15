function id(x: unknown) {
  return x
}

function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{id(/x/)}</Wrap>
}
