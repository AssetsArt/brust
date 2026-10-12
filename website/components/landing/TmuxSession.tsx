// The hero's tmux session (native): three panes play the quickstart (typing and line reveals are CSS under `.play`); the focus moves install → edit → run.
import { useEffect, useState } from 'react'

export default function TmuxSession({ version }: { version: string }) {
  const [active, setActive] = useState(0)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setActive(2)
      return
    }
    const a = setTimeout(() => setActive(1), 1300)
    const b = setTimeout(() => setActive(2), 2300)
    return () => {
      clearTimeout(a)
      clearTimeout(b)
    }
  }, [])
  return (
    <div className="tmux" aria-label="A brust quickstart session">
      <div className="inner">
        <div className="panes" id="panes" data-active={active}>
          <div className="pane edit p1">
            <header>
              <span>routes.tsx</span>
              <span>1:edit</span>
            </header>
            <pre>
              <span className="ln" style={{ '--d': '1.35s' }}>
                <span className="k">import</span> {'{ defineRoutes }'} <span className="k">from</span> <span className="s">'@brust/core/routes'</span>
              </span>
              {'\n'}
              <span className="ln" style={{ '--d': '1.45s' }}>
                <span className="k">import</span> Layout <span className="k">from</span> <span className="s">'./components/Layout'</span>
              </span>
              {'\n'}
              <span className="ln" style={{ '--d': '1.55s' }}>
                <span className="k">import</span> HomePage <span className="k">from</span> <span className="s">'./pages/HomePage'</span>
              </span>
              {'\n\n'}
              <span className="ln" style={{ '--d': '1.7s' }}>
                <span className="k">export const</span> routes = <span className="f">defineRoutes</span>([
              </span>
              {'\n'}
              <span className="ln" style={{ '--d': '1.8s' }}>
                {'  { Component: Layout, children: ['}
              </span>
              {'\n'}
              <span className="ln" style={{ '--d': '1.9s' }}>
                {"    { path: "}
                <span className="s">'/'</span>
                {', Component: HomePage },'}
              </span>
              {'\n'}
              <span className="ln" style={{ '--d': '2.0s' }}>
                {'  ] },'}
              </span>
              {'\n'}
              <span className="ln" style={{ '--d': '2.1s' }}>
                {'])'}
              </span>
            </pre>
          </div>
          <div className="pane p0">
            <header>
              <span>~/</span>
              <span>0:install</span>
            </header>
            <pre>
              <span className="ps">$ </span>
              <span className="type" style={{ '--n': '35', '--d': '.35s' }}>
                bun create @brust/app@latest my-app
              </span>
              {'\n'}
              <span className="ps ln" style={{ '--d': '1.15s' }}>
                ${' '}
              </span>
              <span className="ln" style={{ '--d': '1.15s' }}>
                cd my-app &amp;&amp; bun install
              </span>
            </pre>
          </div>
          <div className="pane p2">
            <header>
              <span>~/my-app</span>
              <span>2:run</span>
            </header>
            <pre>
              <span className="ps">$ </span>
              <span className="type" style={{ '--n': '30', '--d': '2.35s' }}>
                curl -i http://127.0.0.1:1337/
              </span>
              {'\n'}
              <span className="ln c" style={{ '--d': '3.1s' }}>
                HTTP/1.1 200 OK
              </span>
              {'\n'}
              <span className="ln c" style={{ '--d': '3.2s' }}>
                x-powered-by: brust/{version}
              </span>
              {'\n'}
              <span className="ln c" style={{ '--d': '3.3s' }}>
                content-type: text/html; charset=utf-8
              </span>
            </pre>
          </div>
        </div>
        <div className="status" id="status">
          <span>[my-app]</span>
          <span className={active === 0 ? 'w on' : 'w'}>0:install</span>
          <span className={active === 1 ? 'w on' : 'w'}>1:edit</span>
          <span className={active === 2 ? 'w on' : 'w'}>2:run</span>
          <span className="right">brust {version}</span>
        </div>
      </div>
    </div>
  )
}
