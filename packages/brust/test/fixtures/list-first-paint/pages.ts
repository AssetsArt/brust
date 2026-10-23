import PEmpty from './p_empty'
import PNoindex from './p_noindex'
import PPanel from './p_panel'
import PReorder from './p_reorder'
import PRepro from './p_repro'
import PStepper from './p_stepper'

/** F412's pages by route name. */
export const pages: Record<string, unknown> = { repro: PRepro, noindex: PNoindex, reorder: PReorder, stepper: PStepper, panel: PPanel, empty: PEmpty }
