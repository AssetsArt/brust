import { defineRoutes } from '@brust/core/routes'
import P7a_m from './pages/7a-m'
import P7a_d from './pages/7a-d'
import P7b_m from './pages/7b-m'
import P7b_d from './pages/7b-d'
import P7c_m from './pages/7c-m'
import P7c_d from './pages/7c-d'
import P7d_m from './pages/7d-m'
import P7d_d from './pages/7d-d'
import P7e_m from './pages/7e-m'
import P7e_d from './pages/7e-d'
import P8a_m from './pages/8a-m'
import P8a_d from './pages/8a-d'
import P8b_m from './pages/8b-m'
import P8b_d from './pages/8b-d'
import P8c_m from './pages/8c-m'
import P8c_d from './pages/8c-d'
import P8d_m from './pages/8d-m'
import P8d_d from './pages/8d-d'
import P8e_m from './pages/8e-m'
import P8e_d from './pages/8e-d'
import P8f_m from './pages/8f-m'
import P8f_d from './pages/8f-d'
import P7a_im from './pages/7a-im'
import P7a_id from './pages/7a-id'
import P7d_im from './pages/7d-im'
import P7d_id from './pages/7d-id'
import P8a_im from './pages/8a-im'
import P8a_id from './pages/8a-id'
import P8d_im from './pages/8d-im'
import P8d_id from './pages/8d-id'

const who = ({ req }: { req: { search: Record<string, string> } }) => ({ who: req.search.who ?? 'nobody' })

export const routes = defineRoutes([
  { path: '/7a-m', Component: P7a_m },
  { path: '/7a-d', Component: P7a_d },
  { path: '/7b-m', Component: P7b_m },
  { path: '/7b-d', Component: P7b_d },
  { path: '/7c-m', Component: P7c_m },
  { path: '/7c-d', Component: P7c_d },
  { path: '/7d-m', Component: P7d_m },
  { path: '/7d-d', Component: P7d_d },
  { path: '/7e-m', Component: P7e_m },
  { path: '/7e-d', Component: P7e_d },
  { path: '/8a-m', Component: P8a_m },
  { path: '/8a-d', Component: P8a_d },
  { path: '/8b-m', Component: P8b_m },
  { path: '/8b-d', Component: P8b_d },
  { path: '/8c-m', Component: P8c_m, loader: who },
  { path: '/8c-d', Component: P8c_d, loader: who },
  { path: '/8d-m', Component: P8d_m },
  { path: '/8d-d', Component: P8d_d },
  { path: '/8e-m', Component: P8e_m },
  { path: '/8e-d', Component: P8e_d },
  { path: '/8f-m', Component: P8f_m },
  { path: '/8f-d', Component: P8f_d },
  { path: '/7a-im', Component: P7a_im },
  { path: '/7a-id', Component: P7a_id },
  { path: '/7d-im', Component: P7d_im },
  { path: '/7d-id', Component: P7d_id },
  { path: '/8a-im', Component: P8a_im },
  { path: '/8a-id', Component: P8a_id },
  { path: '/8d-im', Component: P8d_im },
  { path: '/8d-id', Component: P8d_id },
])
