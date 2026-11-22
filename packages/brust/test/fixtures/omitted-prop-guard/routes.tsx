import { defineRoutes, type RuntimeComponents } from '@brust/core'
import PageOff from './PageOff'
import PageOn from './PageOn'

export const components: RuntimeComponents = {
  resolve(ref, { build }) {
    if (ref !== 'hello') return null
    return { v: 1, build, id: 'rc_hello_v1', tier: 'static', jinja: '<b class="rc-hello">{{ label | e }}</b>', client: null, features: [], stores: [] }
  },
}

const data = () => ({ show: true, items: [{ id: 'a' }, { id: 'b' }] })

export const routes = defineRoutes([
  { path: '/off', Component: PageOff, loader: data },
  { path: '/on', Component: PageOn, loader: data },
])
