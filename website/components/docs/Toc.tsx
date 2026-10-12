// "On this page" (native tier): links to the page's step headings; the link of the section being read gets
// aria-current and the dot moves to it (transform via --ind-y). Without JS it is a plain list of anchors.
import { useEffect, useState } from 'react'
import type { TocItem } from '../../lib/nav'

export default function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState('')
  useEffect(() => {
    const toc = document.querySelector<HTMLElement>('.toc')
    toc?.querySelector('h4')?.setAttribute('data-ready', '') // mounted marker for tests (inside .toc, as ready() expects)
    const onScroll = () => {
      let cur = items.length > 0 ? items[0]!.id : ''
      for (const it of items) {
        const h = document.getElementById(it.id)
        if (h && h.getBoundingClientRect().top < 120) cur = it.id
      }
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2 && items.length > 0) cur = items[items.length - 1]!.id
      setActive(cur)
      const a = toc?.querySelector<HTMLElement>(`a[href="#${cur}"]`)
      if (toc && a) toc.style.setProperty('--ind-y', `${a.offsetTop}px`)
    }
    onScroll()
    addEventListener('scroll', onScroll, { passive: true })
    addEventListener('resize', onScroll)
    return () => {
      removeEventListener('scroll', onScroll)
      removeEventListener('resize', onScroll)
    }
  }, [items])
  return (
    <aside className="toc" aria-label="On this page">
      <span className="ind" aria-hidden="true" />
      <h4>On this page</h4>
      {items.map((it) => (
        <a key={it.id} href={`#${it.id}`} aria-current={active === it.id ? 'location' : undefined}>
          {it.title}
        </a>
      ))}
    </aside>
  )
}
