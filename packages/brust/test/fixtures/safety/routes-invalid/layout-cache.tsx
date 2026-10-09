import Home from './Home'
import Layout from './Layout'
export const routes = [{ Component: Layout, cache: { ttl_seconds: 5 }, children: [{ path: '/', Component: Home }] }]
