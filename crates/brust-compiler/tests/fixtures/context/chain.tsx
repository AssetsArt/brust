function Box({ kind, children }: { kind: string; children?: React.ReactNode }) {
  if (kind === 'a') {
    const tag = 'A:' + kind
    return <p data-t={tag}>{children}</p>
  }
  if (kind === 'b') {
    const other = 'B:' + kind
    return <section data-t={other}>{children}</section>
  }
  return <div>{children}</div>
}
export default function Page() {
  return (
    <main>
      <Box kind="a">x</Box>
      <Box kind="b">y</Box>
      <Box kind="c">z</Box>
    </main>
  )
}
