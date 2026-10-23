// A component with no state: the server alone prints the falsy values (props of the page's child).
function Row({ n, s, flag }: { n: number; s: string; flag: boolean }) {
  return (
    <p data-testid="row">
      {n && <b>n</b>}|{s && <b>s</b>}|{flag && <b>f</b>}
    </p>
  )
}

export default function StaticPage() {
  return (
    <main>
      <Row n={0} s="" flag={false} />
      <Row n={2} s="x" flag={true} />
    </main>
  )
}
