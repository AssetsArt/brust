import { Outer, OuterFlip, OuterFrame, Root, Thumb } from './Kit'

export default function Page() {
  return (
    <main>
      <OuterFrame>
        <Root data-testid="root">
          <Thumb />
        </Root>
        <Outer />
        <OuterFlip />
      </OuterFrame>
    </main>
  )
}
