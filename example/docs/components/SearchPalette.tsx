// SearchPalette — the docs site's ONLY React island. Hosted in DocsLayout via
// the Island helper with hydrate="idle" and NO `ssr` prop → the host div
// stays empty until idle hydration; `.search-slot` in app.css reserves the
// header space so nothing shifts when the button appears. (NB: do NOT write
// the literal Island JSX tag in comments here — scanIslandChunks regex-scans
// sources and would demand a matching import.)
//
// - ⌘K / Ctrl+K toggles anywhere; `/` opens only when not typing in a field.
// - Index: /search-index.json (lib/search-index.ts shape:
//   [{ title, path, headings: [{ text, anchor }] }]), fetched ONCE on first
//   open.
// - "Fuzzy" = simple includes-ranking over titles + headings (zero deps):
//   title-prefix < title-includes < heading-prefix < heading-includes.
// - <dialog> (top layer) gives Esc + focus trap for free; backdrop click
//   closes (a click landing on the <dialog> element itself missed the panel).
// - Enter → location.href — full-page nav is fine on the static host.
// - Motion: `palette-in` keyframe (160ms, --ease-out-quart) lives in app.css;
//   the global prefers-reduced-motion rule there flattens it to one frame.
import { useEffect, useMemo, useRef, useState } from 'react'

interface SearchHeading {
  text: string
  anchor: string
}

interface SearchEntry {
  title: string
  path: string
  headings: SearchHeading[]
}

interface SearchResult {
  id: string
  label: string
  /** Page title shown as context on heading hits; '' on page-title hits. */
  context: string
  href: string
}

const RESULT_LIMIT = 12

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** Includes-ranking, stable within each rank (index order = nav order). */
export function rankResults(index: SearchEntry[], rawQuery: string): SearchResult[] {
  const q = rawQuery.trim().toLowerCase()
  if (q === '') return []
  const scored: Array<{ score: number; label: string; context: string; href: string }> = []
  for (const entry of index) {
    const title = entry.title.toLowerCase()
    if (title.includes(q)) {
      scored.push({
        score: title.startsWith(q) ? 0 : 1,
        label: entry.title,
        context: '',
        href: entry.path,
      })
    }
    for (const heading of entry.headings) {
      const text = heading.text.toLowerCase()
      if (text.includes(q)) {
        scored.push({
          score: text.startsWith(q) ? 2 : 3,
          label: heading.text,
          context: entry.title,
          href: `${entry.path}#${heading.anchor}`,
        })
      }
    }
  }
  scored.sort((a, b) => a.score - b.score) // Array.sort is stable
  return scored
    .slice(0, RESULT_LIMIT)
    .map(({ label, context, href }, i) => ({ id: `sp-opt-${i}`, label, context, href }))
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

export default function SearchPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [index, setIndex] = useState<SearchEntry[] | null>(null)
  const [indexFailed, setIndexFailed] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fetchStarted = useRef(false)

  const results = useMemo(() => (index ? rankResults(index, query) : []), [index, query])
  // Results can shrink under a stale active index — clamp at read time.
  const activeIndex = Math.min(active, Math.max(results.length - 1, 0))

  // Global shortcuts. ⌘K/Ctrl+K toggles ALWAYS; `/` only outside form fields.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setOpen((o) => !o)
        return
      }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Fetch the index once, on first open. Aborted on unmount so a rapid
  // open→navigate cycle never leaves a dangling setState callback.
  useEffect(() => {
    if (!open || fetchStarted.current) return
    fetchStarted.current = true
    const ac = new AbortController()
    fetch('/search-index.json', { signal: ac.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`search-index.json → ${res.status}`)
        return res.json()
      })
      .then((data: SearchEntry[]) => setIndex(data))
      .catch((err) => {
        if ((err as Error).name === 'AbortError') return
        setIndexFailed(true)
      })
    return () => ac.abort()
  }, [open])

  // Drive the <dialog> element from state (showModal = focus trap + Esc +
  // ::backdrop). Each open starts from a blank query.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setQuery('')
      setActive(0)
      dialog.showModal()
      inputRef.current?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const navigateTo = (href: string) => {
    setOpen(false)
    location.href = href
  }

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(Math.min(activeIndex + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(Math.max(activeIndex - 1, 0))
    } else if (e.key === 'Enter') {
      const hit = results[activeIndex]
      if (hit) {
        e.preventDefault()
        navigateTo(hit.href)
      }
    }
  }

  const shortcutHint = IS_MAC ? '⌘K' : 'Ctrl K'

  // Empty-state copy: '' → shortcut legend (rendered below); otherwise a
  // status line for the non-result states.
  const emptyMessage = indexFailed
    ? 'Search index unavailable.'
    : query.trim() === ''
      ? null
      : index === null
        ? 'Loading index…'
        : `No results for “${query.trim()}”`

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-full w-full items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-3 text-sm text-fg-muted transition-colors hover:text-fg"
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
      >
        <span>Search</span>
        <kbd className="rounded-[var(--radius-chip)] border border-line bg-bg px-1.5 py-0.5 font-sans text-[0.7rem] text-fg-muted">
          {shortcutHint}
        </kbd>
      </button>

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop-dismiss only — Esc is native <dialog>. */}
      <dialog
        ref={dialogRef}
        className="search-palette"
        aria-label="Search documentation"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // The panel fills the dialog box; a click on the <dialog> element
          // itself can only be the ::backdrop.
          if (e.target === dialogRef.current) setOpen(false)
        }}
      >
        <div className="border-b border-line p-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Search documentation…"
            aria-label="Search documentation"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="sp-results"
            aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? `sp-opt-${activeIndex}` : undefined}
            autoComplete="off"
            spellCheck={false}
            className="h-10 w-full rounded-[var(--radius-control)] bg-transparent px-2.5 text-base text-fg outline-none placeholder:text-fg-muted"
          />
        </div>

        {/* div-based listbox/option (valid ARIA combobox shape; ul/li would
            trip noNoninteractiveElementToInteractiveRole). Focus stays on the
            input — aria-activedescendant points at the active option. */}
        <div
          id="sp-results"
          role="listbox"
          aria-label="Search results"
          className="max-h-80 overflow-y-auto p-2"
        >
          {results.map((r, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: combobox option — keyboard is handled on the input (Enter); focus never leaves it.
            <div
              key={r.id}
              id={r.id}
              role="option"
              tabIndex={-1}
              aria-selected={i === activeIndex}
              onClick={() => navigateTo(r.href)}
              onMouseMove={() => setActive(i)}
              className={`flex min-h-10 cursor-pointer items-baseline justify-between gap-3 rounded-[var(--radius-control)] px-2.5 py-2 text-sm ${
                i === activeIndex ? 'bg-surface text-fg' : 'text-fg-muted'
              }`}
            >
              <span className={i === activeIndex ? 'text-link' : 'text-fg'}>{r.label}</span>
              {r.context !== '' && <span className="shrink-0 text-fg-muted">{r.context}</span>}
            </div>
          ))}

          {results.length === 0 && (
            <div className="px-2.5 py-6 text-center text-sm text-fg-muted">
              {emptyMessage ?? (
                <span className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5">
                  {(
                    [
                      [shortcutHint, 'open'],
                      ['/', 'open'],
                      ['↑↓', 'navigate'],
                      ['↵', 'select'],
                      ['esc', 'close'],
                    ] as const
                  ).map(([keys, verb]) => (
                    <span key={`${keys}-${verb}`}>
                      <kbd className="rounded-[var(--radius-chip)] border border-line bg-surface px-1.5 py-0.5 font-sans text-[0.7rem]">
                        {keys}
                      </kbd>{' '}
                      {verb}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
        </div>
      </dialog>
    </>
  )
}
