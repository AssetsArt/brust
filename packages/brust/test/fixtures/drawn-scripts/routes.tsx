import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineRoutes, notFound, renderStatus } from '@brust/core/routes'
import Kinds from './Kinds'
import Layout from './Layout'
import P11 from './pages/P11'
import P12 from './pages/P12'
import P13 from './pages/P13'
import P2 from './pages/P2'
import P3 from './pages/P3'
import P4 from './pages/P4'
import P5 from './pages/P5'
import P6 from './pages/P6'
import Status from './Status'

/** Case 12: the host W5's chunk mounts, as the build printed it (read at request time from the built manifest). */
function w5Host(): string {
  const m = JSON.parse(readFileSync(join(process.cwd(), 'dist', 'manifest.json'), 'utf8')) as { components: Record<string, unknown> }
  const id = Object.keys(m.components).find((k) => k.startsWith('w5_')) ?? 'w5'
  return `x-data="${id}"`
}

const kinds = ({ params }: { params: { k: string } }) => ({ kind: params.k, fake: params.k === 'fake' ? w5Host() : '' })

export const routes = defineRoutes([
  { path: '/1/{k}', Component: Kinds, loader: kinds },
  { path: '/2', Component: P2 },
  { path: '/3', Component: P3 },
  { path: '/4/{k}', Component: P4, loader: ({ params }: { params: { k: string } }) => ({ full: params.k === 'full' }) },
  { path: '/5', Component: P5 },
  { path: '/6', Component: P6 },
  { path: '/8/{k}', Component: Kinds, loader: kinds, cache: { ttl_seconds: 60 } },
  {
    path: '/9',
    Component: Layout,
    children: [
      {
        path: '{k}',
        Component: Status,
        loader: ({ params }: { params: { k: string } }) =>
          params.k === 'gone' ? notFound({ kind: 'none' }) : params.k === 'deny' ? renderStatus(403, { kind: 'none' }) : { kind: params.k },
      },
    ],
  },
  { path: '/11/{k}', Component: P11, loader: ({ params }: { params: { k: string } }) => ({ kind: params.k }) },
  { path: '/13/{k}', Component: P13, loader: ({ params }: { params: { k: string } }) => ({ kind: params.k }) },
  { path: '/12', Component: P12, loader: ({ req }: { req: { search: Record<string, string> } }) => ({ raw: req.search.raw === '1' ? `<button ${w5Host()}>raw</button>` : '', show: false }) },
])
