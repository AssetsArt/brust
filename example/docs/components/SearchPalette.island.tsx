// REACT ISLAND — the ⌘K command palette (the design's signature shell feature).
// Hydrated once in the Layout; renders nothing until opened. Opens on ⌘K / Ctrl+K
// or a `brust:open-search` event (dispatched by the native SearchTrigger button in
// the topbar). Arrow-key navigation; Enter → SPA navigate. Uses the same token CSS
// vars as the rest of the docs (app.css) so it matches dark/light automatically.
import { CornerDownRight, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { navigate } from 'brustjs/navigation'

interface Entry {
  title: string
  group: string
  href: string
  kw: string
}

const SEARCH: Entry[] = [
  {
    title: 'Introduction',
    group: 'Getting Started',
    href: '/docs/introduction',
    kw: 'what is brust napi hyper bun rust ssr overview',
  },
  {
    title: 'Installation',
    group: 'Getting Started',
    href: '/docs/installation',
    kw: 'install bun create brustjs setup scaffold add',
  },
  {
    title: 'Project structure',
    group: 'Getting Started',
    href: '/docs/project-structure',
    kw: 'folders files directory layout brust.toml config',
  },
  {
    title: 'Your first route',
    group: 'Getting Started',
    href: '/docs/first-route',
    kw: 'hello world page component loader native',
  },
  {
    title: 'Dev & build',
    group: 'Getting Started',
    href: '/docs/commands',
    kw: 'dev build start scripts commands run',
  },
  {
    title: 'Routing',
    group: 'Core concepts',
    href: '/docs/routing',
    kw: 'defineRoutes outlet nested dynamic params loader middleware navigate spa sse websocket',
  },
  {
    title: 'Rendering',
    group: 'Core concepts',
    href: '/docs/rendering',
    kw: 'streaming ssr suspense islands isr cache native minijinja react 19',
  },
  {
    title: 'Native interactivity',
    group: 'Core concepts',
    href: '/docs/native-interactivity',
    kw: 'x-data x-text x-show x-bind x-on x-for behavior directives effect onCleanup ctx',
  },
  {
    title: 'State — the store',
    group: 'Core concepts',
    href: '/docs/store',
    kw: 'signal computed effect defineStore useStore singleton brustjs store',
  },
  {
    title: 'Actions & API',
    group: 'Core concepts',
    href: '/docs/actions',
    kw: 'defineActions treaty client zod validation mcp json playground',
  },
  {
    title: 'Styling',
    group: 'Core concepts',
    href: '/docs/styling',
    kw: 'tailwind v4 css modules theme styles',
  },
  {
    title: 'Agents · MCP',
    group: 'Platform',
    href: '/docs/agents',
    kw: 'mcp model context protocol tools resources agents llm',
  },
  { title: 'CLI', group: 'Platform', href: '/docs/cli', kw: 'brust dev build new command line' },
  {
    title: 'Deployment',
    group: 'Platform',
    href: '/docs/deployment',
    kw: 'deploy linux glibc musl http tls docker production health',
  },
]

export default function SearchPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return SEARCH
    return SEARCH.filter((s) => `${s.title} ${s.group} ${s.kw}`.toLowerCase().includes(t))
  }, [q])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('brust:open-search', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('brust:open-search', onOpen)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      const t = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [open])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection whenever the query changes
  useEffect(() => setSel(0), [q])

  if (!open) return null

  const choose = (s?: Entry) => {
    if (!s) return
    setOpen(false)
    navigate(s.href)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(results.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[sel])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4"
      style={{ paddingTop: '12vh' }}
    >
      <button
        type="button"
        aria-label="Close search"
        className="absolute inset-0 cursor-default"
        style={{
          background: 'color-mix(in oklab, #221f1f 55%, transparent)',
          backdropFilter: 'blur(3px)',
        }}
        onClick={() => setOpen(false)}
      />
      <div
        className="relative w-full max-w-[560px] overflow-hidden rounded-2xl"
        style={{
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-default)',
          boxShadow: '0 24px 56px rgba(0,0,0,0.45)',
        }}
      >
        <div
          className="flex items-center gap-3 px-4"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <Search size={18} style={{ color: 'var(--text-tertiary)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search the docs…"
            className="flex-1 bg-transparent py-4 text-[15px] outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md px-1.5 py-1 text-[11px]"
            style={{ border: '1px solid var(--border-default)', color: 'var(--text-tertiary)' }}
          >
            esc
          </button>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-2">
          {results.length === 0 && (
            <div
              className="px-4 py-10 text-center text-[14px]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              No matches for “{q}”. Try “routing”, “store”, or “mcp”.
            </div>
          )}
          {results.map((s, i) => (
            <button
              key={s.href}
              type="button"
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(s)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors"
              style={i === sel ? { background: 'var(--primary-50)' } : {}}
            >
              <span
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[13px] font-bold"
                style={{
                  background: i === sel ? 'var(--b-accent)' : 'var(--surface-canvas)',
                  color: i === sel ? '#fff' : 'var(--text-tertiary)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                {s.title[0]}
              </span>
              <span className="min-w-0">
                <span
                  className="block truncate text-[14px] font-medium"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {s.title}
                </span>
                <span className="block text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  {s.group}
                </span>
              </span>
              {i === sel && (
                <CornerDownRight
                  size={15}
                  className="ml-auto"
                  style={{ color: 'var(--b-accent)' }}
                />
              )}
            </button>
          ))}
        </div>
        <div
          className="flex items-center gap-4 px-4 py-2.5 text-[11.5px]"
          style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
        >
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
