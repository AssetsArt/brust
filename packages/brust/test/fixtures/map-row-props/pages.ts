import PNested from './p_nested'
import PReorder from './p_reorder'
import PRepro from './p_repro'

/** F396's pages by route name. */
export const pages: Record<string, unknown> = { repro: PRepro, reorder: PReorder, nested: PNested }
