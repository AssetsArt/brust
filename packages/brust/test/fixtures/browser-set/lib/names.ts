import { PAGES } from './pages'

// Read at load: data only while no module the browser loads can write into `PAGES`.
export const NAMES = PAGES.map((p) => p.key)
