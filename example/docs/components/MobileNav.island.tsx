// REACT ISLAND — the mobile nav drawer (the design's hamburger). Hydrated at the
// left of the topbar (lg:hidden). Renders the same grouped nav the server-rendered
// sidebar uses, passed in as a prop. Plain <a> links navigate; the drawer closes
// on backdrop click or Escape. Styled with the shared token CSS vars (app.css).
import { Menu, X, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NAV } from '../lib/nav'

export default function MobileNav() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="b-iconbtn -ml-1 grid h-9 w-9 place-items-center rounded-lg"
      >
        <Menu size={20} />
      </button>

      {open && (
        <div className="fixed inset-0 z-[60]">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default"
            style={{
              background: 'color-mix(in oklab, #221f1f 55%, transparent)',
              backdropFilter: 'blur(3px)',
            }}
          />
          <div
            className="absolute top-0 bottom-0 left-0 w-[300px] max-w-[85vw] overflow-y-auto p-4"
            style={{
              background: 'var(--surface-raised)',
              borderRight: '1px solid var(--border-default)',
              boxShadow: '0 24px 56px rgba(0,0,0,0.45)',
            }}
          >
            <div
              className="mb-4 flex items-center justify-between border-b pb-3"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <span className="flex items-center gap-2.5">
                <span className="b-logo-mark grid h-7 w-7 place-items-center rounded-lg">
                  <Zap size={15} />
                </span>
                <span className="b-wordmark font-extrabold">brust</span>
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="b-iconbtn grid h-8 w-8 place-items-center rounded-lg"
              >
                <X size={18} />
              </button>
            </div>
            {NAV.map((section) => (
              <div key={section.title} className="b-nav-group">
                <p className="b-nav-group__label">{section.title}</p>
                {section.links.map((link) => (
                  <a key={link.href} href={link.href} className="b-navlink">
                    {link.label}
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
