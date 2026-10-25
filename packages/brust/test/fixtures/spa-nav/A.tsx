import { Outlet } from '@brust/core/routes'
import Count from './Count'

/** The active link is server markup computed from the loader's path: A's shell differs between /a/one and /a/two. */
export default function A(props: { path: string }) {
  return (
    <section data-layout="A">
      <Count name="A" />
      <a href="/a/one" className={props.path === '/a/one' ? 'active' : 'link'}>
        one
      </a>
      <a href="/a/two" className={props.path === '/a/two' ? 'active' : 'link'}>
        two
      </a>
      <Outlet />
    </section>
  )
}
