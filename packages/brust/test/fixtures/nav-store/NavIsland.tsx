// useTransition => React tier: an island that reads the built-in store through the React bridge.
import { navigation } from '@brust/core/navigation'
import { useStore } from '@brust/core/store/react'
import { useTransition } from 'react'

export default function NavIsland(props: { id: string }) {
  useTransition()
  const nav = useStore(navigation)
  return (
    <p data-nav={`island-${props.id}`} data-state={nav.state}>
      {nav.state} | {nav.url} | {nav.to ?? '-'}
    </p>
  )
}
