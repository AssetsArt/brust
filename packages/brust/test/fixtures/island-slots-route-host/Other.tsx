import Shell from './Shell'

// Shell is a route component elsewhere: its props are request data, so this page never hands it lowered JSX.
export default function Other() {
  return (
    <Shell title="other">
      <b>hi</b>
    </Shell>
  )
}
