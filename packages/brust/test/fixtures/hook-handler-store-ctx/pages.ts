import * as C from './CtxPages'
import * as S from './StorePages'

/** Each case and spelling (M: member read `s.run`, D: call-site destructuring `run`; IM / ID: the same called from an inline handler, F589) as its own route. */
export const PAGES = {
  '/7a-m': S.S7aM, '/7a-d': S.S7aD, '/7b-m': S.S7bM, '/7b-d': S.S7bD, '/7c-m': S.S7cM, '/7c-d': S.S7cD,
  '/7d-m': S.S7dM, '/7d-d': S.S7dD, '/7e-m': S.S7eM, '/7e-d': S.S7eD,
  '/8a-m': C.C8aM, '/8a-d': C.C8aD, '/8b-m': C.C8bM, '/8b-d': C.C8bD, '/8c-m': C.C8cM, '/8c-d': C.C8cD,
  '/8d-m': C.C8dM, '/8d-d': C.C8dD, '/8e-m': C.C8eM, '/8e-d': C.C8eD, '/8f-m': C.C8fM, '/8f-d': C.C8fD,
  '/7a-im': S.S7aIM, '/7a-id': S.S7aID, '/7d-im': S.S7dIM, '/7d-id': S.S7dID, '/8a-im': C.C8aIM, '/8a-id': C.C8aID, '/8d-im': C.C8dIM, '/8d-id': C.C8dID,
} as const
