import PChain from './p_chain'
import PMore from './p_more'
import PProv from './p_prov'
import PDirect from './p_direct'
import PStatic from './p_static'

/** F319's pages by route name. */
export const pages: Record<string, unknown> = { chain: PChain, prov: PProv, more: PMore, direct: PDirect, static: PStatic }
