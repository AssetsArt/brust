// REACT ISLAND — the "On this page" rail. Reads the h2/h3[id] headings from the
// rendered article on mount (so it works on every native page without per-page
// props) and scroll-spies the active one with an IntersectionObserver. Hydrated
// in the Layout's right column; renders nothing until it finds headings.
import { GitFork } from 'lucide-react'
import { useEffect, useState } from 'react'

interface Head {
  id: string
  text: string
  level: number
}

const REPO = 'https://github.com/AssetsArt/brust'

export default function Toc() {
  const [heads, setHeads] = useState<Head[]>([])
  const [active, setActive] = useState('')

  useEffect(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('.b-prose h2[id], .b-prose h3[id]'),
    )
    const list: Head[] = nodes.map((el) => ({
      id: el.id,
      text: el.textContent ?? '',
      level: el.tagName === 'H3' ? 3 : 2,
    }))
    setHeads(list)
    const first = list[0]
    if (first) setActive(first.id)
    if (nodes.length === 0) return

    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActive((visible[0].target as HTMLElement).id)
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: [0, 1] },
    )
    for (const el of nodes) obs.observe(el)
    return () => obs.disconnect()
  }, [])

  if (heads.length === 0) return null

  return (
    <nav className="b-toc">
      <p className="b-toc__label">On this page</p>
      {heads.map((h) => {
        const cls =
          (h.level === 3 ? 'b-toc__link b-toc__link--h3' : 'b-toc__link') +
          (active === h.id ? ' b-toc__link--active' : '')
        return (
          <a key={h.id} href={`#${h.id}`} className={cls}>
            {h.text}
          </a>
        )
      })}
      <a href={REPO} className="b-toc__edit">
        <GitFork size={13} /> Edit this page
      </a>
    </nav>
  )
}
