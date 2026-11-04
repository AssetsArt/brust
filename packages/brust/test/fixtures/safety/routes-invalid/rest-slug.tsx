import Home from './Home'
export default [
  { path: '/', Component: Home },
  { path: '/{*rest}', Component: Home },
  { path: '/{slug}', Component: Home },
]
