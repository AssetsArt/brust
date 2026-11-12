// useTransition => React tier: an island that renders the item store (F533: it hydrates on the navigated-to id).
import { useStore } from '@brust/core/store/react'
import { useEffect, useTransition } from 'react'
import { item } from './stores/item'

export default function ItemIsland() {
  useTransition()
  const it = useStore(item)
  // the unmount effect reads the live store: on a navigation it runs before the new page's written keys are set
  useEffect(() => () => {
    const w = window as unknown as Record<string, string[]>
    w.__itemIds = [...(w.__itemIds ?? []), `unmount island:${item.snapshot().id}`]
  }, [])
  return (
    <output id="item-island">
      {it.id}:{it.count}
    </output>
  )
}
