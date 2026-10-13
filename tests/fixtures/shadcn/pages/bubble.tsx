import { Bubble, BubbleContent, BubbleGroup } from '../components/ui/bubble'

export default function Page() {
  return (
    <BubbleGroup>
      <Bubble variant="secondary">
        <BubbleContent>Hello, how can I help?</BubbleContent>
      </Bubble>
      <Bubble align="end">
        <BubbleContent>What is brust?</BubbleContent>
      </Bubble>
    </BubbleGroup>
  )
}
