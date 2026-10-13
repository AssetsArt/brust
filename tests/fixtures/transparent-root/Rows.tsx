// A static component whose root is a fragment of rows: no <brust-host> wrapper.
export default function Rows({ a, b }: { a: string; b: string }) {
  return (
    <>
      <tr>
        <td>{a}</td>
      </tr>
      <tr>
        <td>{b}</td>
      </tr>
    </>
  )
}
