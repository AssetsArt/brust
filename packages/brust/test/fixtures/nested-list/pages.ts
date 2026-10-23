import POuter from './p_outer'
import PReorder from './p_reorder'
import PRepro from './p_repro'

/** F406's pages by route name. */
export const pages: Record<string, unknown> = { repro: PRepro, reorder: PReorder, outer: POuter }
