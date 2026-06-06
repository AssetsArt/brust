// NATIVE "playable" demo card — Live pane (the real interactive child) + a
// collapsible Source pane (server-highlighted code). The card's own behavior (auto
// x-data) toggles the source via x-show. `codeHtml` is Prism token HTML from the
// loader, injected raw → `{{ (codeHtml) | safe }}`. The {children} slot hosts the
// live demo (a native child with its own x-data mounts independently).
import type { ReactNode } from 'react'
import { computed, signal } from 'brustjs/store'

export const behavior = () => {
  const open = signal(false)
  const toggle = () => open.set(!open())
  const srcLabel = computed(() => (open() ? 'Hide source' : 'Show source'))
  return { open, toggle, srcLabel }
}

export default function Example({
  title,
  codeHtml,
  children,
}: {
  title: string
  codeHtml: string
  children?: ReactNode
}) {
  return (
    <div className="b-example">
      <div className="b-example__head">
        <span className="b-example__title">{title}</span>
        <button
          type="button"
          x-on-click="toggle"
          x-text="srcLabel"
          aria-label="Toggle source"
          className="b-example__src"
        >
          Show source
        </button>
      </div>
      <div className="b-example__live">{children}</div>
      <div x-show="open" className="b-example__code b-code b-code--bare">
        <div className="b-code__scroll">
          <pre>
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted trusted code (Prism, build-time loader output), never user input */}
            <code dangerouslySetInnerHTML={{ __html: codeHtml }} />
          </pre>
        </div>
      </div>
    </div>
  )
}
