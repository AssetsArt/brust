import { ITEMS } from './data_shared'
// Reads the data module's own list: the module stays in the client graph through this file.
export const countOf = (): number => ITEMS.length
