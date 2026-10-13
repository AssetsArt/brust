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
    // `toc` is the hook the effect above and the tests find the list by; the look is all utilities
    <aside
      className="toc self-start py-9 pl-[15px] text-[13.5px] sticky top-[calc(env(safe-area-inset-top,0px)+40px)] before:absolute before:bottom-9 before:left-0 before:top-9 before:w-px before:bg-rule before:content-[''] max-wide:hidden"
      aria-label="On this page"
    >
      <span className="absolute -left-[3px] top-0 mt-[.62em] h-[7px] w-[7px] rounded-full bg-sun [transform:translateY(var(--ind-y,0))] motion-safe:[transition:transform_.35s_var(--ease)]" aria-hidden="true" />
      <h4 className="mb-2 mt-0 font-display text-[12.5px] font-[750] text-ink">On this page</h4>
      {items.map((it) => (
        <a
          key={it.id}
          className="block py-[.2rem] text-ink-2 no-underline aria-[current]:font-semibold aria-[current]:text-ink motion-safe:[transition:background_.15s,color_.15s,border-color_.15s]"
          href={`#${it.id}`}
          aria-current={active === it.id ? 'location' : undefined}
        >
          {it.title}
        </a>
      ))}
    </aside>
  )
}
