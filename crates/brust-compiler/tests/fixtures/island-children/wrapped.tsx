import Frame from './wrapper'

export default function Page() {
  return (
    <main>
      <Frame title="a">
        <p>hi</p>
      </Frame>
      <Frame title="b" />
    </main>
  )
}
