import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server.node'
import { useNav } from './react.ts'
import { runInNavContext } from './server-context.ts'
import { __resetNavForTest } from './store.ts'

// End-to-end proof of the SSR active-nav fix: a React island that derives its
// active class from useNav() must render ACTIVE during SSR when a request-scoped
// nav context is open (the studio SidebarNav case). useNav → useSyncExternalStore
// → getServerSnapshot (= getNavState) → the scoped path.
function NavLink() {
  const { path } = useNav()
  return createElement(
    'a',
    { href: '/design', className: path === '/design' ? 'item is-active' : 'item' },
    'Design',
  )
}

describe('useNav() SSR active state', () => {
  test('without a nav scope, SSR renders inactive (idle default — the OLD behavior)', () => {
    __resetNavForTest()
    expect(renderToString(createElement(NavLink))).not.toContain('is-active')
  })

  test('inside runInNavContext, SSR renders the matching link ACTIVE (the fix)', () => {
    __resetNavForTest()
    const html = runInNavContext('/design', '', () => renderToString(createElement(NavLink)))
    expect(html).toContain('is-active')
  })

  test('a non-matching request path stays inactive under the scope', () => {
    expect(runInNavContext('/', '', () => renderToString(createElement(NavLink)))).not.toContain(
      'is-active',
    )
  })
})
