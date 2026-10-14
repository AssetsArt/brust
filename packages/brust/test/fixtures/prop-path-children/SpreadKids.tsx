import Frame from './Frame'

export default function SpreadKids(props: any) {
  return (
    <main>
      <Frame label="s" {...props}>
        <b data-testid="kid">kid</b>
      </Frame>
    </main>
  )
}
