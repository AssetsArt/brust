import PChain from './p_chain'
import PMore from './p_more'
import PProv from './p_prov'
import PDirect from './p_direct'
import PStatic from './p_static'
import PRest from './p_rest'
import PSpread from './p_spread'
import PRestUp from './p_restup'
import PCond from './p_cond'

/** F319's pages by route name. */
export const pages: Record<string, unknown> = { chain: PChain, prov: PProv, more: PMore, direct: PDirect, static: PStatic, rest: PRest, spread: PSpread, restup: PRestUp, cond: PCond }
