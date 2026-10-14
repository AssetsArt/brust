// A package-source context consumer (Radix `CollapsibleTrigger`) reached through a wrapper, under a Provider that stays a
// React island (`Collapsible.Root`): no frame fills the consumer's context inputs, so it must not lower on its own.
import { Collapsible } from 'radix-ui'

function Root(props: React.ComponentProps<typeof Collapsible.Root>) {
  return <Collapsible.Root data-slot="root" {...props} />
}

function Trigger(props: React.ComponentProps<typeof Collapsible.CollapsibleTrigger>) {
  return <Collapsible.CollapsibleTrigger data-slot="trigger" {...props} />
}

export default function Page() {
  return (
    <Root defaultOpen={false}>
      <Trigger>Toggle</Trigger>
      <Collapsible.CollapsibleContent>Body</Collapsible.CollapsibleContent>
    </Root>
  )
}
