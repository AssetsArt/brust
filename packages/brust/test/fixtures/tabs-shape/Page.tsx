import { Content, Root, Trigger } from './Tabs'

export default function Page() {
  return (
    <main>
      <Root defaultValue="one">
        <Trigger value="one">One</Trigger>
        <Trigger value="two">Two</Trigger>
        <Content value="one" text="first panel" style={{ color: 'red' }} />
        <Content value="two" text="second panel" />
      </Root>
    </main>
  )
}
