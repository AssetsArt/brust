import { useStore } from '@brust/core/store/react'
import { useEffect } from 'react'
import ItemIsland from './ItemIsland'
import { item } from './stores/item'

/** Native (F533): the loader of /i/N writes item.id; the button writes item.count on the client. The effect logs
 * `<this page's N>:<item.id>` each time it runs and its cleanup the store's id when it runs, so an old page seeing the
 * new id, or a new page the old one, shows. */
export default function ItemPage(props: { at: string }) {
  const it = useStore(item)
  useEffect(() => {
    const w = window as unknown as Record<string, string[]>
    w.__itemIds = [...(w.__itemIds ?? []), `${props.at}:${it.id}`]
    // the cleanup reads the live store: on a navigation it runs before the new page's written keys are set
    return () => {
      w.__itemIds = [...(w.__itemIds ?? []), `cleanup ${props.at}:${item.snapshot().id}`]
    }
  }, [it.id, props.at])
  return (
    <article data-page="item">
      <span id="item-id">{it.id}</span>
      <button type="button" id="item-bump" onClick={() => item.count.set(it.count + 1)}>
        {it.count}
      </button>
      <ItemIsland />
      <a id="to-i1" href="/i/1">i1</a> <a id="to-i2" href="/i/2">i2</a> <a id="to-i3" href="/i/3">i3</a>
    </article>
  )
}
