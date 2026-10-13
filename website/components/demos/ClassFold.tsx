// Demo, native tier: what the compiler does with a CSS Modules class read. Type the expression a template uses; the
// handler answers like the build does for the module below: a known class folds to its literal, an unknown one is the
// build error, anything that reads the whole object stays a run-time read. Browser-only: nothing is built or sent.
import { useEffect, useRef, useState } from 'react'

// The class map `Card.module.css` would get (names are the bundler's: observed on 2.0.0-alpha.3, `card_nBzD1A`).
const MAP: Record<string, string> = { card: 'card_nBzD1A', title: 'title_nBzD1A', note: 'note_nBzD1A' }

export default function ClassFold({ initialExpr, initialOut, initialStatus }: { initialExpr: string; initialOut: string; initialStatus: string }) {
  const root = useRef<HTMLInputElement>(null)
  // mounted marker for tests (a native effect runs before the host binds refs and handlers, gap G9: wait one microtask)
  useEffect(() => {
    queueMicrotask(() => root.current?.setAttribute('data-ready', ''))
  }, [])
  const [expr, setExpr] = useState(initialExpr)
  const [out, setOut] = useState(initialOut)
  const [status, setStatus] = useState(initialStatus)
  return (
    <div className="matcher">
      <label className="sr" htmlFor="cf-expr">
        Expression in the template
      </label>
      <input
        ref={root}
        id="cf-expr"
        className="demo-in"
        value={expr}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          const v = e.target.value
          setExpr(v)
          const m = /^\s*styles(?:\.([A-Za-z_][\w-]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*$/.exec(v)
          if (m) {
            const name = m[1] ?? m[2]!
            if (Object.prototype.hasOwnProperty.call(MAP, name)) {
              setOut(`class="${MAP[name]}"`)
              setStatus('folds: a literal in the template, no job')
            } else {
              setOut(`error css-module-class Card.tsx:4:20 class \`${name}\` is not defined in ./Card.module.css`)
              setStatus('build error')
            }
          } else if (/^\s*(styles|Object\.\w+\(\s*styles\s*\).*)\s*$/.test(v)) {
            setOut('(not folded: the whole map is read at run time)')
            setStatus('read at run time, as before')
          } else {
            setOut('(type styles.card, styles["title"], styles.nope or Object.keys(styles))')
            setStatus('not a class read')
          }
        }}
      />
      <dl className="shipbar">
        <div>
          <dt>Compiled</dt>
          <dd data-testid="fold-out">{out}</dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd data-testid="fold-status">{status}</dd>
        </div>
      </dl>
    </div>
  )
}
