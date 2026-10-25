import { navigation } from '@brust/core/navigation'
import { useStore } from '@brust/core/store/react'

/** Native: reads the built-in store in render. */
export default function NavNative() {
  const nav = useStore(navigation)
  return (
    <p data-nav="native" data-state={nav.state}>
      {nav.state} | {nav.url} | {nav.to ?? '-'} | {nav.error ?? '-'} | {nav.status ?? '-'} | {nav.trigger ?? '-'}
    </p>
  )
}
