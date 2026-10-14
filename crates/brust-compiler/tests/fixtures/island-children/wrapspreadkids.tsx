import Frame from './wrapper'

export default function Page(props: any) {
  return (
    <main>
      <Frame {...props}>
        <p>kid</p>
      </Frame>
    </main>
  )
}
