import Counter from './components/Counter'
import NativeLayout from './NativeLayout'

export default function NativeSsrComp({
  greeting,
  counter,
}: {
  greeting: string
  counter: { start: number; label: string }
}) {
  return (
    <NativeLayout title={greeting}>
      <p>SSR component content</p>
      <Island component={Counter} props={counter} hydrate='load' />
    </NativeLayout>
  )
}
