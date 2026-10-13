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
    <div className="border-y border-term-rule bg-[image:radial-gradient(circle_at_100%_0,oklch(40%_0.08_74/.35),transparent_22rem),linear-gradient(135deg,var(--term),oklch(13%_0.035_180))]" aria-label="A brust quickstart session">
      <div className="mx-auto max-w-[1160px] p-4">
        <div className="group/panes grid grid-cols-[1.25fr_1fr] grid-rows-[auto_auto] gap-[6px] font-mono text-[13.5px] leading-[1.65] text-term-fg max-wide:grid-cols-1" id="panes" data-active={active}>
          <div className="flex min-w-0 flex-col rounded-xs border border-term-rule motion-safe:[transition:border-color_.25s,color_.25s] group-data-[active=1]/panes:border-amber [grid-row:1/3] max-wide:[grid-row:auto]">
            <header className="flex justify-between border-b border-term-rule px-[.8rem] py-[.3rem] text-[12px] text-term-dim motion-safe:[transition:border-color_.25s,color_.25s] group-data-[active=1]/panes:text-amber">
              <span>routes.tsx</span>
              <span>1:edit</span>
            </header>
            <pre className="m-0 flex-1 overflow-x-auto px-4 py-[.8rem]">
              <span className="inline-block motion-safe:animate-mirai-ln" style={{ '--d': '1.35s' }}>
                <span className="text-sy-kw">import</span> {'{ defineRoutes }'} <span className="text-sy-kw">from</span> <span className="text-sy-str">'@brust/core/routes'</span>
              </span>
              {'\n'}
              <span className="inline-block motion-safe:animate-mirai-ln" style={{ '--d': '1.45s' }}>
                <span className="text-sy-kw">import</span> Layout <span className="text-sy-kw">from</span> <span className="text-sy-str">'./components/Layout'</span>
              </span>
              {'\n'}
              <span className="inline-block motion-safe:animate-mirai-ln" style={{ '--d': '1.55s' }}>
                <span className="text-sy-kw">import</span> HomePage <span className="text-sy-kw">from</span> <span className="text-sy-str">'./pages/HomePage'</span>
              </span>
              {'\n\n'}
              <span className="inline-block motion-safe:animate-mirai-ln" style={{ '--d': '1.7s' }}>
                <span className="text-sy-kw">export const</span> routes = <span className="text-sy-fn">defineRoutes</span>([
              </span>
              {'\n'}
              <span className="inline-block motion-safe:animate-mirai-ln" style={{ '--d': '1.8s' }}>
                {'  { Component: Layout, children: ['}
              </span>
              {'\n'}
              <span className="inline-block motion-safe:animate-mirai-ln" style={{ '--d': '1.9s' }}>
                {"    { path: "}
                <span className="text-sy-str">'/'</span>
                {', Component: HomePage },'}
              </span>
              {'\n'}
              <span className="inline-block motion-safe:animate-mirai-ln" style={{ '--d': '2.0s' }}>
                {'  ] },'}
              </span>
              {'\n'}
              <span className="inline-block motion-safe:animate-mirai-ln" style={{ '--d': '2.1s' }}>
                {'])'}
              </span>
            </pre>
          </div>
          <div className="flex min-w-0 flex-col rounded-xs border border-term-rule motion-safe:[transition:border-color_.25s,color_.25s] group-data-[active=0]/panes:border-amber">
            <header className="flex justify-between border-b border-term-rule px-[.8rem] py-[.3rem] text-[12px] text-term-dim motion-safe:[transition:border-color_.25s,color_.25s] group-data-[active=0]/panes:text-amber">
              <span>~/</span>
              <span>0:install</span>
            </header>
            <pre className="m-0 flex-1 overflow-x-auto px-4 py-[.8rem]">
              <span className="text-amber select-none">$ </span>
              <span className="inline-block max-w-full overflow-hidden align-bottom whitespace-pre motion-safe:animate-mirai-type" style={{ '--n': '35', '--d': '.35s' }}>
                bun create @brust/app@latest my-app
              </span>
              {'\n'}
              <span className="inline-block motion-safe:animate-mirai-ln text-amber select-none" style={{ '--d': '1.15s' }}>
                ${' '}
              </span>
              <span className="inline-block motion-safe:animate-mirai-ln" style={{ '--d': '1.15s' }}>
                cd my-app &amp;&amp; bun install
              </span>
            </pre>
          </div>
          <div className="flex min-w-0 flex-col rounded-xs border border-term-rule motion-safe:[transition:border-color_.25s,color_.25s] group-data-[active=2]/panes:border-amber">
            <header className="flex justify-between border-b border-term-rule px-[.8rem] py-[.3rem] text-[12px] text-term-dim motion-safe:[transition:border-color_.25s,color_.25s] group-data-[active=2]/panes:text-amber">
              <span>~/my-app</span>
              <span>2:run</span>
            </header>
            <pre className="m-0 flex-1 overflow-x-auto px-4 py-[.8rem]">
              <span className="text-amber select-none">$ </span>
              <span className="inline-block max-w-full overflow-hidden align-bottom whitespace-pre motion-safe:animate-mirai-type" style={{ '--n': '30', '--d': '2.35s' }}>
                curl -i http://127.0.0.1:1337/
              </span>
              {'\n'}
              <span className="inline-block motion-safe:animate-mirai-ln text-sy-cm" style={{ '--d': '3.1s' }}>
                HTTP/1.1 200 OK
              </span>
              {'\n'}
              <span className="inline-block motion-safe:animate-mirai-ln text-sy-cm" style={{ '--d': '3.2s' }}>
                x-powered-by: brust/{version}
              </span>
              {'\n'}
              <span className="inline-block motion-safe:animate-mirai-ln text-sy-cm" style={{ '--d': '3.3s' }}>
                content-type: text/html; charset=utf-8
              </span>
            </pre>
          </div>
        </div>
        <div className="mt-[6px] flex flex-wrap gap-5 rounded-xs bg-amber-fill px-[.7rem] py-[.2rem] font-mono text-[12.5px] text-on-amber" id="status">
          <span>[my-app]</span>
          <span className={active === 0 ? "font-bold after:content-['*']" : 'opacity-65'}>0:install</span>
          <span className={active === 1 ? "font-bold after:content-['*']" : 'opacity-65'}>1:edit</span>
          <span className={active === 2 ? "font-bold after:content-['*']" : 'opacity-65'}>2:run</span>
          <span className="ml-auto">brust {version}</span>
        </div>
      </div>
    </div>
  )
}
